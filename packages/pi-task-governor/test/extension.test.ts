import process from 'node:process'
import { describe, expect, it, vi } from 'vitest'
import { readState, storeDirectory, updateState } from '../src/store.js'
import { claimRoot, declareRoot } from '../src/task.js'
import { DEAD_PID, PARSER_SPEC, useWorkspace } from './helpers.js'
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
      'task_list',
      'task_show',
      'task_cancel',
      'task_answer',
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
      declareRoot(state, PARSER_SPEC, 'main', 'boss', 1)
      claimRoot(
        state,
        'T1',
        {
          sessionId: 'executor-1',
          pid: undefined,
          workspace: { name: 'task-T1', path: workspace.root },
          restarts: 0,
          stalled: 'preparing its workspace failed',
        },
        2,
      )
    })

    await expect(governor.tool('task_answer', { id: 'T1', answer: 'Try again' })).rejects.toThrow(
      'cancel it and declare it again',
    )
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
