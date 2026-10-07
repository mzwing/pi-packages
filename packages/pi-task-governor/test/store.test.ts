import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import { findRepoRoot, initStore, readState, storeDirectory, updateState } from '../src/store.js'
import { DEAD_PID, useWorkspace } from './helpers.js'

describe('store', () => {
  const workspace = useWorkspace()

  it('finds the main workspace from inside it, and not from a secondary workspace', () => {
    const secondary = join(workspace.repo, '..', 'secondary')
    mkdirSync(join(secondary, '.jj'), { recursive: true })
    writeFileSync(join(secondary, '.jj', 'repo'), '../repo/.jj/repo')
    mkdirSync(join(workspace.repo, 'src', 'deep'), { recursive: true })

    expect(findRepoRoot(join(workspace.repo, 'src', 'deep'))).toBe(workspace.repo)
    expect(findRepoRoot(secondary)).toBeUndefined()
  })

  it('saves a change and discards one that throws', () => {
    const store = storeDirectory(workspace.repo)
    initStore(store, DEFAULT_CONFIG)

    updateState(store, state => {
      state.seq = 7
    })
    expect(() =>
      updateState(store, state => {
        state.seq = 8
        throw new Error('rule broken')
      }),
    ).toThrow('rule broken')

    expect(readState(store).seq).toBe(7)
  })

  it('takes over a lock left by a dead process or held for too long', () => {
    const store = storeDirectory(workspace.repo)
    initStore(store, DEFAULT_CONFIG)
    for (const owner of [
      { pid: DEAD_PID, at: Date.now() },
      { pid: process.pid, at: 0 },
    ]) {
      mkdirSync(join(store, 'lock'))
      writeFileSync(join(store, 'lock', 'owner'), JSON.stringify(owner))

      updateState(store, state => {
        state.seq += 1
      })
    }

    expect(readState(store).seq).toBe(2)
  })
})
