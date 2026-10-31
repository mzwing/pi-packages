import type { GovernorConfig } from '../../src/config.js'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { spawnSession } from '@mzwing/pi-session-hub/api'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/config.js'
import { createScheduler } from '../../src/tasks/scheduler.js'
import { initStore, readState, storeDirectory, updateState } from '../../src/tasks/store.js'
import {
  approve,
  beginReview,
  cancelTask,
  claimRoot,
  completeMerge,
  declareRoot,
  logEvent,
} from '../../src/tasks/task.js'
import { environmentPath } from '../../src/workspace/env.js'
import { bookmarkCommit, changedFiles, saveWorkingCopy } from '../../src/workspace/vcs.js'
import { DEAD_PID, PARSER_SPEC, signedOff, useWorkspace } from '../helpers.js'
import { jj } from '../jj.js'

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
        declareRoot(state, PARSER_SPEC, 'main', [], 'boss', 1)
      }
    })
    const notify = vi.fn<(message: string, wake: boolean) => void>()
    // Called at the end of every pass that gets past the pause.
    const changed = vi.fn()
    const scheduler = createScheduler(
      {
        runtime: () => ({ store, repoRoot: workspace.repo, sessionId: 'boss', role: 'coordinator', environment: {} }),
        changed,
      },
      notify,
    )

    return { store, scheduler, notify, changed }
  }

  function launches() {
    return vi.mocked(spawnSession).mock.calls.map(([options]) => options)
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
    expect(existsSync(`${claim.workspace.path}.tmp`)).toBe(true)
    expect(state.tasks['T1']?.base.commit).toBe(
      jj(workspace.repo, 'log', '--no-graph', '-r', 'main', '-T', 'commit_id'),
    )
    expect(spawnSession).toHaveBeenCalledOnce()
    const [launched] = launches()
    expect(launched).toMatchObject({
      cwd: claim.workspace.path,
      sessionId: claim.sessionId,
      args: ['--no-approve', '--no-mcp', '--governor-store', store],
      env: { TMPDIR: `${claim.workspace.path}.tmp` },
    })
    expect(launched?.prompt).toContain('T1: Fix the parser')
    // Executors orchestrate; only their developers change code.
    expect(launched?.tools?.filter(tool => ['bash', 'edit', 'write'].includes(tool))).toEqual([])
  })

  it('starts a task only once the tasks it waits for are merged', async () => {
    const { store, scheduler } = setUp({}, 0)
    updateState(store, state => {
      declareRoot(state, PARSER_SPEC, 'main', [], 'boss', 1)
      declareRoot(state, PARSER_SPEC, 'main', ['T1'], 'boss', 1)
    })

    scheduler.tick()
    await vi.waitFor(() => expect(spawnSession).toHaveBeenCalledOnce())
    expect(readState(store).tasks['T2']?.state).toBe('declared')
    updateState(store, state => completeMerge(state, 'T1', 'c1', 'c0', 2))
    scheduler.tick()

    await vi.waitFor(() => expect(spawnSession).toHaveBeenCalledTimes(2))
    expect(readState(store).tasks['T2']?.state).toBe('claimed')
  })

  it('relaunches an executor that exits early in a fresh session each time, until the task stalls', async () => {
    const { store, scheduler, notify } = setUp()
    nextPid = DEAD_PID

    scheduler.tick()
    for (let restart = 0; restart < 3; restart += 1) {
      await vi.waitFor(() => expect(exits).toHaveLength(1))
      exits.shift()!()
    }

    await vi.waitFor(() =>
      expect(readState(store).tasks['T1']?.claim?.stalled).toBe(
        'it went through 3 executor sessions since your last word on it, and the last one stopped before the task ended',
      ),
    )
    expect(readState(store).tasks['T1']?.claim?.sessions).toBe(3)
    expect(new Set(launches().map(options => options.sessionId)).size).toBe(3)
    expect(launches()[1]?.prompt).toContain(`taking over from session ${launches()[0]?.sessionId}`)
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('T1 stalled'), true)
  })

  it('hands a task the coordinator answered to a fresh session that sees the answer', async () => {
    const { store, scheduler } = setUp()
    updateState(store, state => {
      // As task_answer leaves it.
      const task = claimRoot(
        state,
        'T1',
        {
          sessionId: 'executor-1',
          pid: undefined,
          workspace: { name: 'task-T1', path: workspace.root },
          sessions: 0,
          handoff: true,
        },
        2,
      )
      logEvent(task, 'asked: Which API version?', 3)
      logEvent(task, 'answered: Use v2', 4)
    })

    scheduler.tick()
    await vi.waitFor(() => expect(spawnSession).toHaveBeenCalledOnce())

    const [relaunched] = launches()
    expect(relaunched?.sessionId).not.toBe('executor-1')
    expect(relaunched?.prompt).toContain('taking over from session executor-1')
    expect(relaunched?.prompt).toContain('- T1 asked: Which API version?\n- T1 answered: Use v2')
    const claim = readState(store).tasks['T1']?.claim
    expect(claim).toMatchObject({ sessionId: relaunched?.sessionId, pid: process.pid, sessions: 1 })
    expect(claim?.handoff).toBeUndefined()
  })

  it("stalls a task that ran through its executor sessions without the coordinator's word, even by handoffs", async () => {
    const { store, scheduler, notify } = setUp()
    updateState(store, state => {
      claimRoot(
        state,
        'T1',
        {
          sessionId: 'executor-3',
          pid: undefined,
          workspace: { name: 'task-T1', path: workspace.root },
          sessions: 3,
          handoff: true,
        },
        2,
      )
    })

    scheduler.tick()

    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        'T1 stalled: it went through 3 executor sessions since your last word on it, and the last one handed off',
        true,
      ),
    )
    expect(readState(store).tasks['T1']?.claim?.stalled).toContain('handed off')
    expect(spawnSession).not.toHaveBeenCalled()
  })

  it('starts the review an executor died in over when it relaunches that executor', async () => {
    const { store, scheduler } = setUp()
    updateState(store, state => {
      claimRoot(
        state,
        'T1',
        { sessionId: 'executor-1', pid: DEAD_PID, workspace: { name: 'task-T1', path: workspace.root }, sessions: 0 },
        2,
      )
      beginReview(state, 'T1', 'executor-1', 'c1', 3)
    })

    scheduler.tick()
    await vi.waitFor(() => expect(spawnSession).toHaveBeenCalledOnce())

    expect(readState(store).tasks['T1']).toMatchObject({ state: 'claimed', claim: { sessions: 1 } })
    expect(readState(store).tasks['T1']?.log.map(entry => entry.event)).toContain(
      'reopened: its executor stopped during the review',
    )
  })

  it('asks the coordinator once to sign off a task that passed its review, and relaunches nothing for it', async () => {
    const { scheduler, notify, changed } = setUp({}, 0)
    const id = await signedOff(workspace, 'a.txt', 'a\n')

    scheduler.tick()
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce())
    scheduler.tick()
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2))

    const requests = notify.mock.calls.filter(([message]) => message.includes('passed its review'))
    expect(requests).toHaveLength(1)
    const [request, wake] = requests[0]!
    expect(wake).toBe(true)
    expect(request).toContain(`${id} passed its review and waits for your sign-off before it merges into main`)
    expect(request).toContain('- A1 Tests pass: `pnpm test` passed\n- A2 No API change: No export changed')
    expect(request).toContain('+a')
    expect(spawnSession).not.toHaveBeenCalled()
  })

  it('tells the coordinator which other tasks change the same files, and which wait, as it signs a task off', async () => {
    const { store, scheduler, notify } = setUp({}, 0)
    const merged = await signedOff(workspace, 'shared.txt', 'line1\nline2 by T1\nline3\n')
    const reviewed = await signedOff(workspace, 'shared.txt', 'line1\nline2\nline3 by T2\n')
    const open = await signedOff(workspace, 'shared.txt', 'line1 by T3\nline2\nline3\n')
    const { base, signedCommit } = readState(store).tasks[merged]!
    jj(workspace.repo, 'bookmark', 'set', 'main', '-r', signedCommit!)
    updateState(store, state => {
      completeMerge(state, merged, signedCommit!, base.commit!, 5)
      declareRoot(state, PARSER_SPEC, 'main', [reviewed], 'boss', 6)
    })

    scheduler.tick()

    await vi.waitFor(() =>
      expect(notify.mock.calls.filter(([message]) => message.includes('passed its review'))).toHaveLength(2),
    )
    const [request] = notify.mock.calls.flatMap(([message]) =>
      message.startsWith(`${reviewed} passed its review`) ? [message] : [],
    )
    expect(request).toContain(
      `Other tasks change files that ${reviewed} changes too:\n- ${merged}, merged into main since ${reviewed} started: shared.txt\n- ${open}, still open: shared.txt`,
    )
    expect(request).toContain(
      `These tasks wait for ${reviewed} and start as soon as it merges, on briefs written before it ran:\n- T4: Fix the parser`,
    )
  })

  it('merges the commit of a task the coordinator approved, with the message it gave, then removes its workspace', async () => {
    const { store, scheduler, notify } = setUp({}, 0)
    const id = await signedOff(workspace, 'a.txt', 'a\n')
    const { base, signedCommit, claim } = readState(store).tasks[id]!
    updateState(store, state => approve(state, id, 'boss', 'fix(parser): accept CRLF line endings', 5))

    scheduler.tick()

    await vi.waitFor(() => expect(readState(store).tasks[id]?.state).toBe('done'))
    expect(readState(store).tasks[id]?.merged).toBe(await bookmarkCommit(workspace.repo, 'main'))
    expect(jj(workspace.repo, 'log', '--no-graph', '-r', `${base.commit}..main`, '-T', 'description')).toBe(
      'fix(parser): accept CRLF line endings\n',
    )
    expect(await changedFiles(workspace.repo, signedCommit!, 'main')).toEqual([])
    expect(notify).toHaveBeenCalledWith(`${id} is merged into main, and every task is finished.`, true)
    await vi.waitFor(() => expect(existsSync(claim!.workspace.path)).toBe(false))
    expect(spawnSession).not.toHaveBeenCalled()
  })

  it('sends an approved task whose merge conflicts to a fresh executor session, measured from what landed', async () => {
    const { store, scheduler, notify } = setUp({}, 0)
    const first = await signedOff(workspace, 'shared.txt', 'line1\nline2 by T1\nline3\n')
    const second = await signedOff(workspace, 'shared.txt', 'line1\nline2 by T2\nline3\n')
    updateState(store, state => {
      approve(state, first, 'boss', 'fix: reword line 2', 5)
      approve(state, second, 'boss', 'fix: credit line 2', 5)
    })

    scheduler.tick()

    await vi.waitFor(() => expect(spawnSession).toHaveBeenCalledOnce())
    expect(readState(store).tasks[first]?.state).toBe('done')
    expect(notify).toHaveBeenCalledWith(`${first} is merged into main.`, false)
    expect(readState(store).tasks[second]).toMatchObject({
      state: 'claimed',
      base: { commit: await bookmarkCommit(workspace.repo, 'main') },
    })
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining(`${second} went back to its executor: merging into main conflicted`),
      false,
    )
    expect(launches()[0]?.prompt).toContain('merging into main conflicted')
  })

  it('sends back an approved task whose workspace changed after its review', async () => {
    const { store, scheduler, notify } = setUp({}, 0)
    const id = await signedOff(workspace, 'a.txt', 'a\n')
    const { base, claim } = readState(store).tasks[id]!
    writeFileSync(join(claim!.workspace.path, 'b.txt'), 'b\n')
    await saveWorkingCopy(workspace.repo, claim!.workspace, base.commit!)
    updateState(store, state => approve(state, id, 'boss', 'fix(parser): accept CRLF line endings', 5))

    scheduler.tick()

    await vi.waitFor(() => expect(readState(store).tasks[id]?.state).toBe('claimed'))
    expect(notify).toHaveBeenCalledWith(
      `${id} went back to its executor: its workspace changed after its review`,
      false,
    )
  })

  it('reports an approved merge that fails, and drops the approval for the coordinator to give again', async () => {
    const { store, scheduler, notify, changed } = setUp({}, 0)
    const id = await signedOff(workspace, 'a.txt', 'a\n')
    updateState(store, state => {
      approve(state, id, 'boss', 'fix(parser): accept CRLF line endings', 5)
      state.tasks[id]!.base.bookmark = 'gone'
    })

    scheduler.tick()

    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(expect.stringContaining(`Merging ${id} into gone failed`), true),
    )
    // The pass the failed merge starts asks for the sign-off again.
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2))
    const task = readState(store).tasks[id]
    expect([task?.state, task?.approval]).toEqual(['approving', undefined])
  })

  it('reports a cleanup that fails and goes on scheduling', async () => {
    const { store, scheduler, notify } = setUp({}, 2)
    const stray = join(workspace.root, 'stray')
    mkdirSync(stray)
    updateState(store, state => {
      claimRoot(
        state,
        'T1',
        { sessionId: 'executor-1', pid: DEAD_PID, workspace: { name: 'task-T1', path: stray }, sessions: 0 },
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
      declareRoot(state, PARSER_SPEC, 'main', [], 'boss', 3)
    })

    scheduler.tick()

    await vi.waitFor(() => expect(existsSync(path)).toBe(false))
    expect(existsSync(`${path}.tmp`)).toBe(false)
    expect(jj(workspace.repo, 'workspace', 'list')).not.toContain('task-T1')
    expect(readState(store).tasks['T2']?.state).toBe('declared')
  })
})
