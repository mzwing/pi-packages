import type { GovernorConfig } from './config.js'
import type { State } from './task.js'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { isAlive } from '@mzwing/pi-session-hub/api'
import { emptyState } from './task.js'

// A holder keeps the lock for one synchronous read-modify-write, so an older lock was left by a crash.
const LOCK_STALE_MS = 10_000
const LOCK_RETRY_MS = 20

interface LockOwner {
  pid: number
  at: number
}

/** The main workspace holds the repo in `.jj/repo`; other workspaces only have a file there pointing at it. */
export function findRepoRoot(cwd: string): string | undefined {
  for (let directory = cwd; ; directory = dirname(directory)) {
    if (statSync(join(directory, '.jj', 'repo'), { throwIfNoEntry: false })?.isDirectory() === true) {
      return directory
    }
    if (dirname(directory) === directory) {
      return undefined
    }
  }
}

export function storeDirectory(repoRoot: string): string {
  return join(repoRoot, '.jj', 'pi-task-governor')
}

function statePath(store: string): string {
  return join(store, 'state.json')
}

export function storeExists(store: string): boolean {
  return existsSync(statePath(store))
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value))
  renameSync(temporary, path)
}

export function readState(store: string): State {
  return JSON.parse(readFileSync(statePath(store), 'utf8')) as State
}

/** `undefined` once the lock is released; the owner file is in place before the lock appears. */
function readOwner(lock: string): LockOwner | undefined {
  try {
    return JSON.parse(readFileSync(join(lock, 'owner'), 'utf8')) as LockOwner
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

/** A directory renamed into place carries its owner atomically, which a bare mkdir followed by a write would not. */
function acquireLock(store: string): string {
  const lock = join(store, 'lock')
  for (;;) {
    const candidate = `${lock}.${randomUUID()}`
    mkdirSync(candidate)
    writeFileSync(join(candidate, 'owner'), JSON.stringify({ pid: process.pid, at: Date.now() } satisfies LockOwner))
    try {
      renameSync(candidate, lock)

      return lock
    } catch {
      rmSync(candidate, { recursive: true, force: true })
    }
    const owner = readOwner(lock)
    if (owner === undefined) {
      continue
    }
    if (!isAlive(owner.pid) || Date.now() - owner.at > LOCK_STALE_MS) {
      rmSync(lock, { recursive: true, force: true })
    } else {
      sleepSync(LOCK_RETRY_MS)
    }
  }
}

function withLock<T>(store: string, action: () => T): T {
  const lock = acquireLock(store)
  try {
    return action()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

/** Runs `change` on the current state under the cross-process lock and saves the result; a throw saves nothing. */
export function updateState<T>(store: string, change: (state: State) => T): T {
  return withLock(store, () => {
    const state = readState(store)
    const result = change(state)
    writeJsonAtomic(statePath(store), state)

    return result
  })
}

export function initStore(store: string, config: GovernorConfig): void {
  mkdirSync(store, { recursive: true })
  withLock(store, () => {
    if (!storeExists(store)) {
      writeJsonAtomic(statePath(store), emptyState(config))
    }
  })
}
