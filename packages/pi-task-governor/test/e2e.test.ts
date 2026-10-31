import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import { createScheduler } from '../src/tasks/scheduler.js'
import { initStore, readState, storeDirectory, updateState } from '../src/tasks/store.js'
import { approve, declareRoot } from '../src/tasks/task.js'
import { ADD_FILE_SPEC, useWorkspace, writeJson } from './helpers.js'
import { jj } from './jj.js'

const HUB = fileURLToPath(new URL('../../pi-session-hub', import.meta.url))
const GOVERNOR = fileURLToPath(new URL('..', import.meta.url))
const FAUX_MODEL = fileURLToPath(new URL('fixtures/faux-model.ts', import.meta.url))

/**
 * Real `pi --print` executors, with in-process developer and reviewer sessions, driven by a scripted model: this
 * process stands in for the coordinator, runs the scheduler and signs the task off
 */
describe('governed task end to end', () => {
  const workspace = useWorkspace()

  beforeAll(() => {
    // The executor loads both packages as Pi does, from their builds
    for (const directory of [HUB, GOVERNOR]) {
      execFileSync('pnpm', ['run', 'build'], { cwd: directory, stdio: 'ignore' })
    }
  })

  it('takes a declared task through development, a handoff, review, sign-off and merge, then cleans up', async () => {
    writeJson(join(workspace.agent, 'settings.json'), {
      extensions: [join(HUB, 'dist', 'index.js'), join(GOVERNOR, 'dist', 'index.js'), FAUX_MODEL],
    })
    const store = storeDirectory(workspace.repo)
    const faux = { model: 'faux/faux-1', maxTurns: 10 }
    initStore(store, {
      ...DEFAULT_CONFIG,
      roles: { ...DEFAULT_CONFIG.roles, executor: faux, developer: faux, reviewer: faux },
    })
    updateState(store, state => {
      state.lease = { sessionId: 'boss', pid: process.pid }
      declareRoot(state, ADD_FILE_SPEC, 'main', [], 'boss', 1)
    })
    // Under vitest the running script is vitest's; with it hidden, the hub starts the `pi` on PATH
    const script = process.argv[1]
    process.argv[1] = ''
    const notify = vi.fn()
    const scheduler = createScheduler(
      {
        runtime: () => ({ store, repoRoot: workspace.repo, sessionId: 'boss', role: 'coordinator', environment: {} }),
        changed: () => {},
      },
      notify,
    )
    const waiting = { timeout: 120_000, interval: 500 }

    try {
      scheduler.tick()
      await vi.waitFor(
        () => expect(notify).toHaveBeenCalledWith(expect.stringContaining('T1 passed its review'), true),
        waiting,
      )
      updateState(store, state => approve(state, 'T1', 'boss', 'feat: add `a.txt`', Date.now()))
      scheduler.tick()
      await vi.waitFor(() => expect(readState(store).tasks['T1']?.state).toBe('done'), waiting)
    } finally {
      process.argv[1] = script!
    }
    const task = readState(store).tasks['T1']!

    expect(jj(workspace.repo, 'file', 'show', '-r', 'main', 'a.txt')).toBe('hello\n')
    expect(task.merged).toBe(jj(workspace.repo, 'log', '--no-graph', '-r', 'main', '-T', 'commit_id'))
    expect(jj(workspace.repo, 'log', '--no-graph', '-r', `${task.base.commit}..main`, '-T', 'description')).toBe(
      'feat: add `a.txt`\n',
    )
    expect(task.reviews).toMatchObject([
      {
        verdict: 'pass',
        evidence: { A1: { kind: 'check', exitCode: 0 }, A2: { kind: 'observation', text: 'a.txt line 1 reads hello' } },
      },
    ])
    expect(task.signedBy).not.toBe(task.claim?.sessionId)
    expect(task.note).toBe('a.txt is written; it needs its review.')
    expect(task.log.map(entry => entry.event.replace(/session \S+/, 'session X'))).toEqual(
      expect.arrayContaining([
        'executor session X started',
        'executor session X handed off by choice',
        'approved by boss',
      ]),
    )
    expect(task.log.filter(entry => entry.event.endsWith(' started'))).toHaveLength(2)
    await vi.waitFor(() => expect(existsSync(task.claim!.workspace.path)).toBe(false), { timeout: 60_000 })
    expect(existsSync(`${task.claim!.workspace.path}.tmp`)).toBe(false)
    expect(readFileSync(join(workspace.repo, 'shared.txt'), 'utf8')).toBe('line1\nline2\nline3\n')
  }, 240_000)
})
