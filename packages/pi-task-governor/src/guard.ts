import type { Runtime } from './runtime.js'
import type { State } from './task.js'
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
import { childBinding } from './children.js'
import { applyChanges } from './env.js'
import { readState } from './store.js'
import { isOpen } from './task.js'

const SHIMMED_COMMANDS = ['git', 'jj', 'pi']
// The shims catch every invocation through PATH, including from scripts, xargs and `sh -c`. These catch the ways
// around PATH: a path to the binary, a binary fetched through nix, and the repository metadata itself.
const BINARY_PATH = /(?:^|[\s;&|(`'"=])[^\s;&|(`'"=]*\/(?:git|jj|pi)(?=$|[\s;&|)`'"])/
const NIX_BINARY = /\bnix\s+(?:run|shell)\s[^;&|\n]*?\b(?:git|jujutsu|jj|pi)\b/
const METADATA = /(?:^|[\s/'"=:])\.(?:jj|git)(?=$|[\s/'"])/
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

function isUnlocked(state: State, sessionId: string): boolean {
  return (state.unlocks[sessionId] ?? 0) > Date.now()
}

export function blockedCommand(command: string): boolean {
  return BINARY_PATH.test(command) || NIX_BINARY.test(command) || METADATA.test(command)
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
 * Replaces `bash` in a governed session with one whose commands run with the git, jj and pi shims first on PATH and
 * inside the task's environment. The hook rewrites only the spawned process, never the command text that
 * pi-permission-system matches its rules against.
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
        if (!isUnlocked(readState(runtime.store), runtime.sessionId)) {
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
    if (runtime === undefined) {
      return undefined
    }
    if (isToolCallEventType('bash', event)) {
      return !isUnlocked(readState(runtime.store), runtime.sessionId) && blockedCommand(event.input.command)
        ? { block: true, reason: BLOCKED_COMMAND }
        : undefined
    }
    if (isToolCallEventType('edit', event) || isToolCallEventType('write', event)) {
      const refusal = writeRefusal(
        readState(runtime.store),
        runtime,
        resolveToolPath(event.input.path, ctx.cwd),
        childBinding(runtime.sessionId)?.workspace.path,
      )

      return refusal === undefined ? undefined : { block: true, reason: refusal }
    }

    return undefined
  })
}
