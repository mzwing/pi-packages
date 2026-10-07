import type { ThinkingLevel } from './config.js'
import type { EnvironmentChanges } from './env.js'
import type { CheckEvidence } from './task.js'
import type { Workspace } from './vcs.js'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { basename, dirname, join } from 'node:path'
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { readState } from './store.js'
import { requireTask } from './task.js'

const BINDINGS = Symbol.for('pi-task-governor:children')
const WRAP_UP_TURNS = 2

const DEVELOPER_TOOLS: string[] = ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash']
const REVIEWER_TOOLS: string[] = ['read', 'grep', 'find', 'ls', 'task_diff', 'task_check', 'task_verdict']

/** What a developer or reviewer session works on, registered before its extensions bind. */
export interface ChildBinding {
  role: 'developer' | 'reviewer'
  store: string
  taskId: string
  workspace: Workspace
  /** The task environment its executor runs in, handed down. */
  environment: EnvironmentChanges
  /** The head a reviewer judges, pinned when the review starts. */
  commit: string
  /** A reviewer's check runs, by criterion. */
  checks: Record<string, CheckEvidence>
  verdict?: 'pass' | 'fail' | undefined
}

export interface ChildOptions {
  binding: ChildBinding
  model: string | undefined
  thinking: ThinkingLevel | undefined
  maxTurns: number
  prompt: string
}

/**
 * Bindings live on `globalThis`, which only code in this process reaches: unlike a session id or a flag, a bash
 * command cannot present one. Children share their executor's process, so they find theirs here.
 */
function bindings(): Map<string, ChildBinding> {
  const global = globalThis as Record<symbol, Map<string, ChildBinding> | undefined>
  global[BINDINGS] ??= new Map()

  return global[BINDINGS]
}

export function childBinding(sessionId: string): ChildBinding | undefined {
  return bindings().get(sessionId)
}

function resolveModel(ctx: ExtensionContext, configured: string | undefined): ExtensionContext['model'] {
  if (configured === undefined) {
    return ctx.model
  }
  const separator = configured.indexOf('/')
  const model = ctx.modelRegistry.find(configured.slice(0, separator), configured.slice(separator + 1))
  if (model === undefined) {
    throw new Error(`The configured model ${configured} is not available.`)
  }

  return model
}

/**
 * Runs a developer or reviewer as an in-process SDK session in the task workspace, nested under the executor's
 * session, and returns its final report. Its project resources stay unloaded, since the workspace is the work under
 * review; a reviewer also skips the workspace's context files for the same reason.
 */
export async function runChild(
  ctx: ExtensionContext,
  options: ChildOptions,
  signal: AbortSignal | undefined,
): Promise<string> {
  const { binding } = options
  const cwd = binding.workspace.path
  const agentDir = getAgentDir()
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false })
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noContextFiles: binding.role === 'reviewer',
  })
  await resourceLoader.reload()
  // A fresh runtime would lack the providers this session's extensions registered at runtime.
  const modelRuntime = await ModelRuntime.create()
  const registry = new ModelRegistry(modelRuntime)
  for (const id of ctx.modelRegistry.getRegisteredProviderIds()) {
    const native = ctx.modelRegistry.getRegisteredNativeProvider(id)
    const config = ctx.modelRegistry.getRegisteredProviderConfig(id)
    if (native !== undefined) {
      registry.registerProvider(native)
    } else if (config !== undefined) {
      registry.registerProvider(id, config)
    }
  }
  const parentFile = ctx.sessionManager.getSessionFile()!
  const sessionManager = SessionManager.create(cwd, join(dirname(parentFile), basename(parentFile, '.jsonl')))
  sessionManager.newSession({ parentSession: parentFile })
  const sessionId = sessionManager.getSessionId()
  const model = resolveModel(ctx, options.model)
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    sessionManager,
    settingsManager,
    resourceLoader,
    modelRuntime,
    ...(model === undefined ? {} : { model }),
    ...(options.thinking === undefined ? {} : { thinkingLevel: options.thinking }),
    tools: binding.role === 'developer' ? DEVELOPER_TOOLS : REVIEWER_TOOLS,
  })
  bindings().set(sessionId, binding)
  const abort = (): void => {
    void session.abort()
  }
  signal?.addEventListener('abort', abort)
  let turns = 0
  const unsubscribe = session.subscribe(event => {
    if (event.type !== 'turn_end') {
      return
    }
    turns += 1
    if (turns === options.maxTurns - WRAP_UP_TURNS) {
      void session.steer(`You have ${WRAP_UP_TURNS} turns left. Finish now and give your final answer.`)
    }
    // Cancelling stops a task's child here and its executor at its next tool call, which no longer holds the role.
    if (turns >= options.maxTurns || requireTask(readState(binding.store), binding.taskId).state === 'cancelled') {
      abort()
    }
  })
  try {
    // Not announced to pi-permission-system as an in-process subagent: that would send its asks to the headless
    // executor, which answers none. Inheriting the executor's PI_SUBAGENT_PARENT_SESSION sends them to the coordinator.
    await session.bindExtensions({})
    await session.prompt(options.prompt)

    return session.getLastAssistantText() ?? ''
  } finally {
    unsubscribe()
    signal?.removeEventListener('abort', abort)
    session.dispose()
    bindings().delete(sessionId)
  }
}
