import { existsSync } from 'node:fs'
import process from 'node:process'
import { describe, expect, it, vi } from 'vitest'
import { readState, storeDirectory, updateState } from '../src/tasks/store.js'
import { claimRoot, declareRoot } from '../src/tasks/task.js'
import { DEAD_PID, PARSER_SPEC, signedOff, useWorkspace } from './helpers.js'
import { loadGovernor } from './pi.js'

vi.mock(import('@mzwing/pi-session-hub/api'), async importOriginal => ({
  ...(await importOriginal()),
  spawnSession: vi.fn(() => ({ pid: process.pid, on: vi.fn(), unref: vi.fn() }) as never),
}))

describe('governor extension', () => {
  const workspace = useWorkspace()

  it('leaves an ungoverned repository alone until a TUI session coordinates it', async () => {
    const headless = loadGovernor({ cwd: workspace.repo, sessionId: 'print-session', mode: 'print' })
    await headless.start()
    await headless.command('coordinate')
    expect(headless.notices).toEqual([])

    const governor = loadGovernor({ cwd: workspace.repo, sessionId: 'boss' })
    await governor.start()
    expect(governor.statuses).toEqual([])
    await governor.command('coordinate')

    expect(readState(storeDirectory(workspace.repo)).lease).toEqual({ sessionId: 'boss', pid: process.pid })
    expect(governor.active()).toEqual([
      'read',
      'bash',
      'session_list',
      'task_declare',
      'task_revise',
      'task_list',
      'task_show',
      'task_cancel',
      'task_answer',
      'task_approve',
      'task_reject',
    ])
    expect(governor.statuses.at(-1)).toBe('governor 0/3')
  })

  it('declares, lists and cancels tasks for the coordinator only', async () => {
    const governor = loadGovernor({ cwd: workspace.repo, sessionId: 'boss' })
    await governor.start()
    await governor.command('coordinate')
    await governor.command('pause')

    await governor.tool('task_declare', PARSER_SPEC)
    await expect(governor.tool('task_declare', { ...PARSER_SPEC, bookmark: 'nonexistent' })).rejects.toThrow(
      'nonexistent',
    )
    expect(governor.statuses.at(-1)).toBe('governor 0/3 · 1 queued · paused')
    expect((await governor.tool('task_list', {})).content).toEqual([
      { type: 'text', text: 'T1 [declared] Fix the parser' },
    ])
    await governor.tool('task_cancel', { id: 'T1', reason: 'not needed' })
    expect(readState(storeDirectory(workspace.repo)).tasks['T1']?.state).toBe('cancelled')

    const bystander = loadGovernor({ cwd: workspace.repo, sessionId: 'bystander' })
    await bystander.start()
    await expect(bystander.tool('task_declare', PARSER_SPEC)).rejects.toThrow('Only the coordinator session')
  })

  it('has a task that stalled before its executor started declared again rather than answered', async () => {
    const governor = loadGovernor({ cwd: workspace.repo, sessionId: 'boss' })
    await governor.start()
    await governor.command('coordinate')
    updateState(storeDirectory(workspace.repo), state => {
      declareRoot(state, PARSER_SPEC, 'main', [], 'boss', 1)
      claimRoot(
        state,
        'T1',
        {
          sessionId: undefined,
          pid: undefined,
          workspace: { name: 'task-T1', path: workspace.root },
          sessions: 0,
          stalled: 'preparing its workspace failed',
        },
        2,
      )
    })

    await expect(governor.tool('task_answer', { id: 'T1', answer: 'Try again' })).rejects.toThrow(
      'cancel it and declare it again',
    )
  })

  it('lets the coordinator alone sign off a reviewed task, which then merges, or send it back', async () => {
    const governor = loadGovernor({ cwd: workspace.repo, sessionId: 'boss' })
    await governor.start()
    await governor.command('coordinate')
    const approved = await signedOff(workspace, 'a.txt', 'a\n')
    const refused = await signedOff(workspace, 'b.txt', 'b\n')
    const bystander = loadGovernor({ cwd: workspace.repo, sessionId: 'bystander' })
    await bystander.start()

    await expect(bystander.tool('task_approve', { id: approved, commitMessage: 'feat: add `a.txt`' })).rejects.toThrow(
      'Only the coordinator session',
    )
    await governor.tool('task_reject', { id: refused, findings: 'Duplicates the lexer' })
    await governor.tool('task_approve', { id: approved, commitMessage: 'feat: add `a.txt`' })

    expect(readState(storeDirectory(workspace.repo)).tasks[refused]).toMatchObject({
      state: 'claimed',
      reviews: [{ verdict: 'pass' }, { reviewer: 'boss', verdict: 'fail', findings: 'Duplicates the lexer' }],
    })
    await vi.waitFor(() => expect(readState(storeDirectory(workspace.repo)).tasks[approved]?.state).toBe('done'))
    // The scheduler removes the merged task's workspace afterwards, which must finish before the repository goes.
    await vi.waitFor(() => expect(existsSync(`${workspace.repo}.tasks/${approved}`)).toBe(false))
  })

  it('lets the coordinator revise a task that waits to start or for its answer, but not one at work', async () => {
    const governor = loadGovernor({ cwd: workspace.repo, sessionId: 'boss' })
    await governor.start()
    await governor.command('coordinate')
    await governor.command('pause')
    const store = storeDirectory(workspace.repo)
    updateState(store, state => {
      declareRoot(state, PARSER_SPEC, 'main', [], 'boss', 1)
      for (const [id, pid] of [
        ['T2', DEAD_PID],
        ['T3', process.pid],
      ] as const) {
        declareRoot(state, PARSER_SPEC, 'main', [], 'boss', 1)
        claimRoot(
          state,
          id,
          {
            sessionId: `executor-${id}`,
            pid,
            workspace: { name: `task-${id}`, path: workspace.root },
            sessions: 2,
            question: 'Which API?',
          },
          2,
        )
      }
    })

    await governor.tool('task_revise', { id: 'T1', reason: 'Only the lexer is broken', boundary: 'src/lexer only' })
    await governor.tool('task_revise', {
      id: 'T2',
      reason: 'The check named no test',
      acceptance: [{ statement: 'Lexer tests pass', check: 'pnpm test lexer' }],
    })
    await expect(governor.tool('task_revise', { id: 'T3', reason: 'Too late', title: 'Other' })).rejects.toThrow(
      'T3 has no executor waiting for an answer',
    )

    const { tasks } = readState(store)
    expect(tasks['T1']).toMatchObject({ state: 'declared', spec: { boundary: 'src/lexer only' } })
    expect(tasks['T1']?.log.at(-1)?.event).toBe('brief of T1 revised by boss: Only the lexer is broken')
    expect(tasks['T2']?.spec.acceptance.map(criterion => criterion.check)).toEqual(['pnpm test lexer'])
    expect(tasks['T2']?.claim).toMatchObject({ sessions: 0, handoff: true })
    expect(tasks['T2']?.claim?.question).toBeUndefined()
    expect(tasks['T2']?.log.at(-1)?.event).toBe('brief of T2 revised by boss: The check named no test')
    expect(tasks['T3']?.title).toBe('Fix the parser')
  })

  it('sends a task the coordinator revises at its sign-off back to be reviewed against the new brief', async () => {
    const governor = loadGovernor({ cwd: workspace.repo, sessionId: 'boss' })
    await governor.start()
    await governor.command('coordinate')
    // Paused before the task waits for its sign-off, so no sign-off request or fresh executor outlives the test.
    await governor.command('pause')
    const signed = await signedOff(workspace, 'a.txt', 'a\n')

    await governor.tool('task_revise', { id: signed, reason: 'Keep the old API', nonGoals: ['Changing the API'] })

    expect(readState(storeDirectory(workspace.repo)).tasks[signed]).toMatchObject({
      state: 'claimed',
      spec: { nonGoals: ['Changing the API'] },
      reviews: [
        { verdict: 'pass' },
        { reviewer: 'boss', verdict: 'fail', findings: 'its brief was revised: Keep the old API' },
      ],
    })
  })

  it('reminds the coordinator to hand off once it has run its turns', async () => {
    const governor = loadGovernor({ cwd: workspace.repo, sessionId: 'boss' })
    await governor.start()
    await governor.command('coordinate')
    updateState(storeDirectory(workspace.repo), state => {
      state.config.roles.coordinator.maxTurns = 2
    })

    for (let turn = 0; turn < 3; turn += 1) {
      await governor.emit('turn_end', {})
    }

    expect(governor.notices.filter(notice => notice.type === 'warning')).toEqual([
      {
        message:
          'This coordinator session has run 2 turns; /governor handoff continues in a fresh one seeded from the task board.',
        type: 'warning',
      },
    ])
  })

  it('keeps the lease with a live coordinator and hands a dead one to whoever resumes it', async () => {
    const governor = loadGovernor({ cwd: workspace.repo, sessionId: 'boss' })
    await governor.start()
    await governor.command('coordinate')

    const rival = loadGovernor({ cwd: workspace.repo, sessionId: 'rival' })
    await rival.start()
    await rival.command('coordinate')
    expect(rival.notices.at(-1)).toEqual({
      message: 'Session boss already coordinates this repository.',
      type: 'error',
    })

    updateState(storeDirectory(workspace.repo), state => {
      state.lease = { sessionId: 'boss', pid: DEAD_PID }
    })
    const resumed = loadGovernor({ cwd: workspace.repo, sessionId: 'boss' })
    await resumed.start()

    expect(readState(storeDirectory(workspace.repo)).lease).toEqual({ sessionId: 'boss', pid: process.pid })
    expect(resumed.active()).toContain('task_declare')
  })

  it('hands a lease marked for handoff to the next session of the same process', async () => {
    const governor = loadGovernor({ cwd: workspace.repo, sessionId: 'boss' })
    await governor.start()
    await governor.command('coordinate')
    updateState(storeDirectory(workspace.repo), state => {
      state.lease!.handoff = true
    })

    const fresh = loadGovernor({ cwd: workspace.repo, sessionId: 'fresh' })
    await fresh.start()

    expect(readState(storeDirectory(workspace.repo)).lease).toEqual({ sessionId: 'fresh', pid: process.pid })
    expect(fresh.active()).toContain('task_answer')
  })
})
