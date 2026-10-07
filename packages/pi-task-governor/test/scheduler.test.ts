import type { GovernorConfig } from '../src/config.js'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { spawnSession } from '@mzwing/pi-session-hub/api'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import { environmentPath } from '../src/env.js'
import { createScheduler } from '../src/scheduler.js'
import { initStore, readState, storeDirectory, updateState } from '../src/store.js'
import { beginReview, cancelTask, claimRoot, declareRoot } from '../src/task.js'
import { DEAD_PID, PARSER_SPEC, useWorkspace } from './helpers.js'
import { jj } from './jj.js'

const exits: (() => void)[] = []
let nextPid = process.pid

vi.mock(import('@mzwing/pi-session-hub/api'), async importOriginal => ({
  ...(await importOriginal()),
  spawnSession: vi.fn(
    () =>
      ({
        pid: nextPid,
        on: (_event: string, handler: () => void) => exits.push(handler),
        unref: vi.fn(),
      }) as never,
  ),
}))

describe('scheduler', () => {
  const workspace = useWorkspace()

  beforeEach(() => {
    exits.length = 0
    nextPid = process.pid
    vi.mocked(spawnSession).mockClear()
  })

  function setUp(config: Partial<GovernorConfig> = {}, tasks = 1) {
    const store = storeDirectory(workspace.repo)
    initStore(store, { ...DEFAULT_CONFIG, ...config })
    updateState(store, state => {
      state.lease = { sessionId: 'boss', pid: process.pid }
      for (let index = 0; index < tasks; index += 1) {
        declareRoot(state, PARSER_SPEC, 'main', 'boss', 1)
      }
    })
    const notify = vi.fn()
    const scheduler = createScheduler(
      {
        runtime: () => ({ store, repoRoot: workspace.repo, sessionId: 'boss', role: 'coordinator', environment: {} }),
        changed: () => {},
      },
      notify,
    )

    return { store, scheduler, notify }
  }

  it('starts queued root tasks within the budget, each in a workspace of its own', async () => {
    const { store, scheduler } = setUp({ maxExecutors: 1 }, 2)

    scheduler.tick()
    await vi.waitFor(() => expect(readState(store).tasks['T1']?.claim?.pid).toBe(process.pid))

    const state = readState(store)
    const claim = state.tasks['T1']!.claim!
    expect(state.tasks['T2']?.state).toBe('declared')
    expect(claim.workspace).toEqual({ name: 'task-T1', path: join(`${workspace.repo}.tasks`, 'T1') })
    expect(existsSync(join(claim.workspace.path, 'shared.txt'))).toBe(true)
    expect(state.tasks['T1']?.base.commit).toBe(
      jj(workspace.repo, 'log', '--no-graph', '-r', 'main', '-T', 'commit_id'),
    )
    expect(spawnSession).toHaveBeenCalledOnce()
    const launched = vi.mocked(spawnSession).mock.calls[0]![0]
    expect(launched).toMatchObject({
      cwd: claim.workspace.path,
      sessionId: claim.sessionId,
      args: ['--no-approve', '--governor-store', store],
    })
    expect(launched.prompt).toContain('T1: Fix the parser')
    // Executors orchestrate; only their developers change code.
    expect(launched.tools?.filter(tool => ['bash', 'edit', 'write'].includes(tool))).toEqual([])
  })

  it('restarts an executor that exits early, until the task stalls', async () => {
    const { store, scheduler, notify } = setUp()
    nextPid = DEAD_PID

    scheduler.tick()
    for (let restart = 0; restart < 3; restart += 1) {
      await vi.waitFor(() => expect(exits).toHaveLength(1))
      exits.shift()!()
    }

    await vi.waitFor(() => expect(readState(store).tasks['T1']?.claim?.stalled).toContain('stopped 3 times'))
    expect(readState(store).tasks['T1']?.claim?.restarts).toBe(2)
    expect(spawnSession).toHaveBeenCalledTimes(3)
    expect(vi.mocked(spawnSession).mock.calls[1]?.[0].prompt).toContain('was restarted')
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('T1 stalled'), true)
  })

  it("restarts an asking executor with the coordinator's answer", async () => {
    const { store, scheduler } = setUp()
    updateState(store, state => {
      claimRoot(
        state,
        'T1',
        {
          sessionId: 'executor-1',
          pid: DEAD_PID,
          workspace: { name: 'task-T1', path: workspace.root },
          restarts: 0,
          question: 'Which API version?',
          answer: 'Use v2',
        },
        2,
      )
    })

    scheduler.tick()
    await vi.waitFor(() => expect(spawnSession).toHaveBeenCalledOnce())

    const relaunched = vi.mocked(spawnSession).mock.calls[0]![0]
    expect(relaunched.sessionId).toBe('executor-1')
    expect(relaunched.prompt).toContain('Use v2')
    const claim = readState(store).tasks['T1']?.claim
    expect(claim?.pid).toBe(process.pid)
    expect([claim?.question, claim?.answer]).toEqual([undefined, undefined])
  })

  it('starts the review an executor died in over when it restarts that executor', async () => {
    const { store, scheduler } = setUp()
    updateState(store, state => {
      claimRoot(
        state,
        'T1',
        { sessionId: 'executor-1', pid: DEAD_PID, workspace: { name: 'task-T1', path: workspace.root }, restarts: 0 },
        2,
      )
      beginReview(state, 'T1', 'executor-1', 'c1', 3)
    })

    scheduler.tick()
    await vi.waitFor(() => expect(spawnSession).toHaveBeenCalledOnce())

    expect(readState(store).tasks['T1']).toMatchObject({ state: 'claimed', claim: { restarts: 1 } })
    expect(readState(store).tasks['T1']?.log.at(-1)?.event).toBe('reopened: its executor stopped during the review')
  })

  it('reports a cleanup that fails and goes on scheduling', async () => {
    const { store, scheduler, notify } = setUp({}, 2)
    const stray = join(workspace.root, 'stray')
    mkdirSync(stray)
    updateState(store, state => {
      claimRoot(
        state,
        'T1',
        { sessionId: 'executor-1', pid: DEAD_PID, workspace: { name: 'task-T1', path: stray }, restarts: 0 },
        2,
      )
      cancelTask(state, 'T1', 'boss', 'not needed', 3)
    })
    mkdirSync(join(store, 'env'))
    writeFileSync(environmentPath(store, 'T1'), 'truncated {')

    scheduler.tick()
    await vi.waitFor(() => expect(spawnSession).toHaveBeenCalledOnce())

    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Cleaning up after T1 failed'), false)
    expect(readState(store).tasks['T2']?.state).toBe('claimed')
  })

  it('stalls a task whose workspace cannot be prepared', async () => {
    const { store, scheduler, notify } = setUp({ env: { provider: 'none', setup: ['echo "no lockfile" >&2; exit 3'] } })

    scheduler.tick()

    await vi.waitFor(() => expect(readState(store).tasks['T1']?.claim?.stalled).toContain('no lockfile'))
    expect(spawnSession).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('preparing its workspace failed'), true)
  })

  it('removes the workspace of a finished task once its executor is gone, and launches nothing while paused', async () => {
    const { store, scheduler } = setUp()
    scheduler.tick()
    await vi.waitFor(() => expect(readState(store).tasks['T1']?.claim?.pid).toBe(process.pid))
    const path = readState(store).tasks['T1']!.claim!.workspace.path
    updateState(store, state => {
      state.paused = true
      state.tasks['T1']!.state = 'done'
      state.tasks['T1']!.claim!.pid = DEAD_PID
      declareRoot(state, PARSER_SPEC, 'main', 'boss', 3)
    })

    scheduler.tick()

    await vi.waitFor(() => expect(existsSync(path)).toBe(false))
    expect(jj(workspace.repo, 'workspace', 'list')).not.toContain('task-T1')
    expect(readState(store).tasks['T2']?.state).toBe('declared')
  })
})
