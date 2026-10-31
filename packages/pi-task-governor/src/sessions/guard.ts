import type { State } from '../tasks/task.js'
import type { Runtime } from './runtime.js'
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from '@earendil-works/pi-coding-agent'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  createBashToolDefinition,
  getAgentDir,
  isToolCallEventType,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { readState } from '../tasks/store.js'
import { isOpen } from '../tasks/task.js'
import { applyChanges } from '../workspace/env.js'
import { childBinding } from './children.js'

// The shims catch every invocation through PATH, including from scripts, xargs and `sh -c`.
const SHIMMED_COMMANDS = ['git', 'jj', 'pi']
const BLOCKED_COMMAND =
  'git, jj and pi are blocked in this governed session: version control goes through the task tools, and only a human can lift this with /governor unlock.'

export function shimDirectory(store: string): string {
  return join(store, 'bin')
}

export function writeShims(store: string): void {
  const directory = shimDirectory(store)
  mkdirSync(directory, { recursive: true })
  for (const command of SHIMMED_COMMANDS) {
    const path = join(directory, command)
    writeFileSync(path, `#!/bin/sh\necho "${command}: ${BLOCKED_COMMAND}" >&2\nexit 126\n`)
    chmodSync(path, 0o755)
  }
}

// The coordinator is the user's own session in the main workspace, so git, jj and pi stay open to it.
function isLocked(runtime: Runtime): boolean {
  return runtime.role !== 'coordinator' && (readState(runtime.store).unlocks[runtime.sessionId] ?? 0) <= Date.now()
}

function resolveToolPath(path: string, cwd: string): string {
  const bare = path.startsWith('@') ? path.slice(1) : path
  const expanded = bare === '~' || bare.startsWith('~/') ? join(homedir(), bare.slice(1)) : bare

  return resolve(cwd, expanded)
}

function isInside(path: string, directory: string): boolean {
  const offset = relative(directory, path)

  return offset === '' || (!offset.startsWith('..') && !isAbsolute(offset))
}

/** Why a write to `path` is refused, or undefined when it may go ahead. */
export function writeRefusal(
  state: State,
  runtime: Runtime,
  path: string,
  ownWorkspace: string | undefined,
): string | undefined {
  if (path.split(sep).some(segment => segment === '.jj' || segment === '.git')) {
    return 'Version-control metadata is off limits; the controller commits for you.'
  }
  if (runtime.role === 'developer') {
    return ownWorkspace !== undefined && (isInside(path, ownWorkspace) || isInside(path, tmpdir()))
      ? undefined
      : `A developer writes only inside its task workspace (${ownWorkspace}) or the temporary directory.`
  }
  const workspaces = Object.values(state.tasks)
    .filter(task => isOpen(task) && task.claim !== undefined)
    .map(task => task.claim!.workspace.path)

  return workspaces.some(workspace => isInside(path, workspace))
    ? 'Task workspaces belong to their executors; declare a task to change code there.'
    : undefined
}

/**
 * Replaces `bash` in a governed session with one whose commands run inside the task's environment, with the git, jj and
 * pi shims first on PATH while the session is locked. The hook rewrites only the spawned process, never the command
 * text that pi-permission-system matches its rules against.
 */
export function governBash(pi: ExtensionAPI, ctx: ExtensionContext, currentRuntime: () => Runtime | undefined): void {
  const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() })
  const shellPath = settings.getShellPath()
  const commandPrefix = settings.getShellCommandPrefix()
  pi.registerTool(
    createBashToolDefinition(ctx.cwd, {
      ...(shellPath === undefined ? {} : { shellPath }),
      ...(commandPrefix === undefined ? {} : { commandPrefix }),
      spawnHook: spawned => {
        const runtime = currentRuntime()
        if (runtime === undefined) {
          return spawned
        }
        const env = applyChanges(spawned.env, runtime.environment)
        if (isLocked(runtime)) {
          env['PATH'] = `${shimDirectory(runtime.store)}:${env['PATH'] ?? ''}`
        }

        return { ...spawned, env }
      },
    }),
  )
}

export function registerGuard(pi: ExtensionAPI, currentRuntime: () => Runtime | undefined): void {
  pi.on('tool_call', (event, ctx): ToolCallEventResult | undefined => {
    const runtime = currentRuntime()
    if (runtime === undefined || !(isToolCallEventType('edit', event) || isToolCallEventType('write', event))) {
      return undefined
    }
    const refusal = writeRefusal(
      readState(runtime.store),
      runtime,
      resolveToolPath(event.input.path, ctx.cwd),
      childBinding(runtime.sessionId)?.workspace.path,
    )

    return refusal === undefined ? undefined : { block: true, reason: refusal }
  })
}
