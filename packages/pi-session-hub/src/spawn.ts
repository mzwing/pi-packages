import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import process from 'node:process'
import { hubPath } from './files.js'

const RUNTIME_EXECUTABLE = /^(?:node|bun)(?:\.exe)?$/

export interface SpawnOptions {
  cwd: string
  /** A new id starts a session; the id of a stopped session of the same cwd continues it. */
  sessionId: string
  prompt: string
  name?: string | undefined
  model?: string | undefined
  thinking?: string | undefined
  tools?: string[] | undefined
  /** Further CLI options, placed before the prompt. */
  args?: string[] | undefined
  /** The session this one works for; pi-permission-system sends the new session's permission asks there. */
  parentSessionId?: string | undefined
}

/** Pi runs either as a script under Node or Bun, or as its compiled binary (`/$bunfs/` scripts). */
function piInvocation(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1]
  if (script !== undefined && !script.startsWith('/$bunfs/') && existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] }
  }

  return RUNTIME_EXECUTABLE.test(basename(process.execPath).toLowerCase())
    ? { command: 'pi', args }
    : { command: process.execPath, args }
}

function option(flag: string, value: string | undefined): string[] {
  return value === undefined ? [] : [flag, value]
}

export function logPath(sessionId: string): string {
  return hubPath('logs', `${sessionId}.log`)
}

/**
 * Starts a detached `pi --print` that outlives this process. Print mode reads stdin to its end before it runs, so
 * stdin is closed; the prompt follows `--` so it is never parsed as an option.
 */
export function spawnSession(options: SpawnOptions): ChildProcess {
  const log = logPath(options.sessionId)
  mkdirSync(dirname(log), { recursive: true })
  const output = openSync(log, 'a')
  const invocation = piInvocation([
    '--print',
    '--session-id',
    options.sessionId,
    ...option('--name', options.name),
    ...option('--model', options.model),
    ...option('--thinking', options.thinking),
    ...option('--tools', options.tools?.join(',')),
    ...(options.args ?? []),
    '--',
    options.prompt,
  ])
  try {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env:
        options.parentSessionId === undefined
          ? process.env
          : { ...process.env, PI_SUBAGENT_PARENT_SESSION: options.parentSessionId },
      detached: true,
      stdio: ['ignore', output, output],
    })
    // Without a listener a failed spawn would crash this process; the missing pid already tells the caller.
    child.on('error', error => appendFileSync(log, `${error.message}\n`))

    return child
  } finally {
    closeSync(output)
  }
}
