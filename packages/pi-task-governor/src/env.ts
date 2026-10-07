import type { EnvProvider } from './config.js'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const OUTPUT_LIMIT = 64 * 1024 * 1024
const OUTPUT_TAIL = 4_000

/** How a task's environment differs from the one its sessions inherit; `null` unsets a variable. */
export type EnvironmentChanges = Record<string, string | null>

export interface TaskEnvironment {
  changes: EnvironmentChanges
  /** The workspace's copy in the Nix store, deleted with the workspace. */
  storeCopy?: string | undefined
}

interface DevEnvironment {
  variables: Record<string, { type: string; value: unknown }>
}

export function applyChanges(base: NodeJS.ProcessEnv, changes: EnvironmentChanges): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) {
      delete env[name]
    } else {
      env[name] = value
    }
  }

  return env
}

/** The exported variables of a flake's dev shell, its PATH ahead of the inherited one. */
export function flakeChanges(output: string, inheritedPath: string): EnvironmentChanges {
  const { variables } = JSON.parse(output) as DevEnvironment
  const changes: EnvironmentChanges = {}
  for (const [name, variable] of Object.entries(variables)) {
    if (variable.type === 'exported') {
      changes[name] = String(variable.value)
    }
  }
  if (changes['PATH'] !== undefined) {
    changes['PATH'] = `${changes['PATH']}:${inheritedPath}`
  }

  return changes
}

function chooseProvider(workspace: string, provider: EnvProvider): Exclude<EnvProvider, 'auto'> {
  if (provider !== 'auto') {
    return provider
  }
  if (existsSync(join(workspace, '.envrc'))) {
    return 'direnv'
  }

  return existsSync(join(workspace, 'flake.nix')) ? 'flake' : 'none'
}

async function captureChanges(workspace: string, provider: EnvProvider): Promise<EnvironmentChanges> {
  switch (chooseProvider(workspace, provider)) {
    case 'direnv': {
      // The workspace's .envrc is the one committed to the task's base, so allowing it trusts nothing new.
      await execFileAsync('direnv', ['allow', workspace])
      const { stdout } = await execFileAsync('direnv', ['export', 'json'], { cwd: workspace, maxBuffer: OUTPUT_LIMIT })

      return stdout.trim() === '' ? {} : (JSON.parse(stdout) as EnvironmentChanges)
    }
    case 'flake': {
      // Without the flag, nix would write a flake.lock into the workspace and so into the task's changes.
      const { stdout } = await execFileAsync('nix', ['print-dev-env', '--json', '--no-write-lock-file', workspace], {
        cwd: workspace,
        maxBuffer: OUTPUT_LIMIT,
      })

      return flakeChanges(stdout, process.env['PATH'] ?? '')
    }
    case 'none':
      return {}
  }
}

/** A workspace without .git is a `path:` flake, which Nix copies into its store whole. */
async function findStoreCopy(workspace: string): Promise<string | undefined> {
  if (!existsSync(join(workspace, 'flake.nix'))) {
    return undefined
  }
  const { stdout } = await execFileAsync('nix', [
    'flake',
    'metadata',
    '--json',
    '--no-write-lock-file',
    `path:${workspace}`,
  ])

  return (JSON.parse(stdout) as { path: string }).path
}

async function runSetup(workspace: string, env: NodeJS.ProcessEnv, command: string): Promise<void> {
  try {
    await execFileAsync('sh', ['-c', command], { cwd: workspace, env, maxBuffer: OUTPUT_LIMIT })
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message: string }
    const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.slice(-OUTPUT_TAIL)
    throw new Error(`Setup command \`${command}\` failed: ${output === '' ? failure.message : output}`)
  }
}

/** Captures the workspace's environment, then runs the setup commands in it. */
export async function prepareEnvironment(
  workspace: string,
  provider: EnvProvider,
  setup: string[],
): Promise<TaskEnvironment> {
  const changes = await captureChanges(workspace, provider)
  // Located before setup runs, since a lookup after it would copy whatever setup built into the store as well.
  const storeCopy = await findStoreCopy(workspace)
  const env = applyChanges(process.env, changes)
  for (const command of setup) {
    await runSetup(workspace, env, command)
  }

  return { changes, storeCopy }
}

/** Deleting the workspace drops its .direnv and .devenv gc roots; this then frees its store copy if nothing else holds it. */
export async function releaseEnvironment(environment: TaskEnvironment): Promise<void> {
  if (environment.storeCopy === undefined) {
    return
  }
  try {
    await execFileAsync('nix', ['store', 'delete', environment.storeCopy])
  } catch {
    // Still alive: another gc root holds the same content, for example the main workspace's own copy.
  }
}

export function environmentPath(store: string, taskId: string): string {
  return join(store, 'env', `${taskId}.json`)
}

export function saveEnvironment(store: string, taskId: string, environment: TaskEnvironment): void {
  mkdirSync(join(store, 'env'), { recursive: true })
  writeFileSync(environmentPath(store, taskId), JSON.stringify(environment))
}

export function loadEnvironment(store: string, taskId: string): TaskEnvironment {
  return JSON.parse(readFileSync(environmentPath(store, taskId), 'utf8')) as TaskEnvironment
}
