import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import {
  findLiveSession,
  findSession,
  listLiveSessions,
  registerSession,
  unregisterSession,
} from '../../src/sessions/registry.js'
import { useAgentDir } from '../helpers.js'

// Above every platform's pid range, so it can never be a live process
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

  // A session id may hold `_` itself, so `x_beta` ends in the same `_beta.jsonl`
  it('finds a stopped session of any project by its id, with the cwd it ran in', async () => {
    expect(await findSession('beta')).toBeUndefined()

    const storeSession = (id: string, cwd: string): string => {
      const file = join(agent.root, 'sessions', `-${cwd.replaceAll('/', '-')}-`, `2026-10-31T00-00-00-000Z_${id}.jsonl`)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id, timestamp: '', cwd })}\n`)

      return file
    }
    storeSession('x_beta', '/elsewhere')
    expect(await findSession('beta')).toBeUndefined()

    const file = storeSession('beta', '/other')
    expect(await findSession('beta')).toEqual({ id: 'beta', file, cwd: '/other', running: false })
  })
})
