import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { findLiveSession, listLiveSessions, registerSession, unregisterSession } from '../src/registry.js'
import { useAgentDir } from './helpers.js'

// Above every platform's pid range, so it can never be a live process.
const DEAD_PID = 2 ** 31 - 1

function record(id: string, pid = process.pid) {
  return { id, file: `/sessions/${id}.jsonl`, cwd: '/project', name: undefined, pid }
}

describe('session registry', () => {
  const agent = useAgentDir()

  it('finds a registered session until it unregisters', () => {
    registerSession(record('alpha'))
    expect(findLiveSession('alpha')).toMatchObject({ id: 'alpha', pid: process.pid })

    unregisterSession('alpha')
    expect(findLiveSession('alpha')).toBeUndefined()
  })

  it('lists live sessions and removes the records of dead ones', () => {
    registerSession(record('alpha'))
    registerSession(record('ghost', DEAD_PID))

    expect(listLiveSessions().map(session => session.id)).toEqual(['alpha'])
    expect(existsSync(join(agent.root, 'pi-session-hub', 'registry', 'ghost.json'))).toBe(false)
  })
})
