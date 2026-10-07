import type { EnvironmentChanges } from './env.js'
import type { State } from './task.js'
import process from 'node:process'
import { isAlive } from '@mzwing/pi-session-hub/api'
import { readState } from './store.js'
import { claimedRoot } from './task.js'

export type Role = 'coordinator' | 'executor' | 'developer' | 'reviewer'

/** How this session takes part in a governed repository. */
export interface Runtime {
  store: string
  repoRoot: string
  sessionId: string
  /** Undefined for any other session in the repository, which governance restricts but gives no tools. */
  role: Role | undefined
  /** What the environment of the task this session works on changes in every command it runs; empty outside tasks. */
  environment: EnvironmentChanges
}

/**
 * Roles are rechecked against the store on every call: a lease handed to another session ends this one's, and an
 * executor holds its task only while the store names its pid and the task is open.
 */
export function requireRole(runtime: Runtime | undefined, role: Role): Runtime {
  if (runtime?.role !== role || !stillHolds(runtime, role)) {
    throw new Error(`Only the ${role} session can use this tool.`)
  }

  return runtime
}

function stillHolds(runtime: Runtime, role: Role): boolean {
  switch (role) {
    case 'coordinator': {
      const { lease } = readState(runtime.store)

      return lease?.sessionId === runtime.sessionId && lease.pid === process.pid
    }
    case 'executor':
      return claimedRoot(readState(runtime.store), runtime.sessionId)?.claim?.pid === process.pid
    case 'developer':
    case 'reviewer':
      return true
  }
}

/** A lease whose process died passes to whoever coordinates next. */
export function leaseIsFree(state: State, sessionId: string): boolean {
  return state.lease === undefined || state.lease.sessionId === sessionId || !isAlive(state.lease.pid)
}

/** A TUI session takes back its own lease unless another live process holds it, and takes over one its process handed off. */
export function resumesLease(state: State, sessionId: string): boolean {
  const lease = state.lease
  if (lease?.pid === process.pid) {
    return lease.handoff === true || lease.sessionId === sessionId
  }

  return lease?.sessionId === sessionId && !isAlive(lease.pid)
}
