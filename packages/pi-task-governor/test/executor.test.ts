import type { Mail } from '@mzwing/pi-session-hub/api'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it, vi } from 'vitest'
import { runChild } from '../src/children.js'
import { DEFAULT_CONFIG } from '../src/config.js'
import { saveEnvironment } from '../src/env.js'
import { initStore, readState, storeDirectory, updateState } from '../src/store.js'
import { claimRoot, declareRoot, recordVerdict } from '../src/task.js'
import { addWorkspace, bookmarkCommit, commitWorkingCopy, mergeInto } from '../src/vcs.js'
import { DEAD_PID, PARSER_SPEC, useWorkspace } from './helpers.js'
import { loadGovernor } from './pi.js'

vi.mock(import('../src/children.js'), async importOriginal => ({
  ...(await importOriginal()),
  runChild: vi.fn(async () => {
    throw new Error('model unavailable')
  }),
}))

describe('executor session', () => {
  const workspace = useWorkspace()

  function claimed(pid: number, path = workspace.root): string {
    const store = storeDirectory(workspace.repo)
    initStore(store, DEFAULT_CONFIG)
    updateState(store, state => {
      state.lease = { sessionId: 'boss', pid: process.pid }
      declareRoot(state, PARSER_SPEC, 'main', 'boss', 1)
      claimRoot(state, 'T1', { sessionId: 'executor-1', pid, workspace: { name: 'task-T1', path }, restarts: 0 }, 2)
    })
    saveEnvironment(store, 'T1', { changes: { TASK_FLAG: 'on' } })

    return store
  }

  /** T1 claimed by this process, with `contents` written to `file` in a workspace of its own. */
  async function underWay(file: string, contents: string): Promise<string> {
    const task = { name: 'task-T1', path: join(workspace.root, 'repo.tasks', 'T1') }
    const base = await bookmarkCommit(workspace.repo, 'main')
    await addWorkspace(workspace.repo, task, base)
    writeFileSync(join(task.path, file), contents)
    const store = claimed(process.pid, task.path)
    updateState(store, state => {
      state.tasks['T1']!.base.commit = base
    })

    return store
  }

  function executor(store: string) {
    return loadGovernor({ cwd: workspace.root, sessionId: 'executor-1', mode: 'print', store })
  }

  /** What the governor's settle hooks return, ignoring the ones with nothing to say. */
  async function settle(session: ReturnType<typeof executor>, outcome: string): Promise<unknown> {
    return (await session.emit('agent_before_settle', { outcome })).find(result => result !== undefined)
  }

  function mailToCoordinator(): Mail[] {
    const directory = join(workspace.agent, 'pi-session-hub', 'mail', 'boss')

    return readdirSync(directory).map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')) as Mail)
  }

  it('gives a session started from another pid no role and runs none of its prompts', async () => {
    const session = executor(claimed(DEAD_PID))
    await session.start()

    expect(await session.emit('input', { text: 'do the task', source: 'interactive' })).toEqual([{ action: 'handled' }])
    await expect(session.tool('task_ask', { question: 'Which API?' })).rejects.toThrow('Only the executor session')
  })

  it('adds its role, with what the config adds to it, to the system prompt and asks the coordinator', async () => {
    const store = claimed(process.pid)
    updateState(store, state => {
      state.config.roles.executor.instructions = 'Keep every developer run to one file.'
    })
    const session = executor(store)
    await session.start()
    const event = { systemPromptOptions: { sections: { existing: 'kept' } as Record<string, string> } }

    await session.emit('before_agent_start', event)
    await session.tool('task_ask', { question: 'Which API version?' })

    expect(Object.keys(event.systemPromptOptions.sections)).toEqual(['existing', 'governor_role'])
    expect(event.systemPromptOptions.sections['governor_role']).toMatch(
      /^You are the executor of one task in a governed jj repository\.[\s\S]*\nKeep every developer run to one file\.$/,
    )
    expect(readState(store).tasks['T1']?.claim?.question).toBe('Which API version?')
    const [mail] = mailToCoordinator()
    expect(mail).toMatchObject({ from: 'executor-1', fromName: 'T1 executor', wake: true })
    expect(mail?.body).toContain('Which API version?')
    expect(await settle(session, 'completed')).toBeUndefined()
  })

  it('keeps its role in a system prompt another extension forced', async () => {
    const session = executor(claimed(process.pid))
    await session.start()
    const forced = 'Forced by another extension.'

    const [result] = await session.emit('before_agent_start', {
      systemPrompt: forced,
      systemPromptOptions: { forceSystemPrompt: forced, sections: {} },
    })

    expect((result as { systemPrompt: string }).systemPrompt).toMatch(
      /^Forced by another extension\.\n\n<governor_role>\nYou are the executor of one task in a governed jj repository\./,
    )
  })

  it('sends an unfinished run back to work a few times, then stalls the task', async () => {
    const store = claimed(process.pid)
    const session = executor(store)
    await session.start()

    expect(await settle(session, 'error')).toBeUndefined()
    for (let nudge = 0; nudge < 3; nudge += 1) {
      const result = (await settle(session, 'completed')) as { continue: boolean; entries: { content: string }[] }
      expect(result.continue).toBe(true)
      expect(result.entries[0]?.content).toContain('T1 is still claimed')
    }
    expect(await settle(session, 'completed')).toBeUndefined()

    expect(readState(store).tasks['T1']?.claim?.stalled).toContain('tried to stop 4 times')
    const [mail] = mailToCoordinator()
    expect(mail?.wake).toBe(true)
    expect(mail?.body).toContain('T1 stalled')
  })

  it('sends its task back to work when a review breaks off', async () => {
    const store = await underWay('a.txt', 'hello\n')
    const session = executor(store)
    await session.start()

    await expect(session.tool('task_review', {})).rejects.toThrow('model unavailable')

    expect(readState(store).tasks['T1']?.state).toBe('claimed')
    expect(readState(store).tasks['T1']?.log.at(-1)?.event).toBe('reopened: its review ended unfinished')
  })

  it('reviews only its own changes after a conflicting merge takes in what landed on main', async () => {
    const store = await underWay('shared.txt', 'line1\nline2 by T1\nline3\n')
    const other = { name: 'task-T2', path: join(workspace.root, 'repo.tasks', 'T2') }
    await addWorkspace(workspace.repo, other, await bookmarkCommit(workspace.repo, 'main'))
    writeFileSync(join(other.path, 'shared.txt'), 'line1\nline2 by T2\nline3\n')
    await commitWorkingCopy(other, 'T2: edit line 2')
    await mergeInto(workspace.repo, other, 'main', 'T2: merge main', async () => undefined)
    const landed = await bookmarkCommit(workspace.repo, 'main')
    vi.mocked(runChild).mockImplementationOnce(async (_ctx, { binding }) => {
      updateState(binding.store, state =>
        recordVerdict(state, binding.taskId, {
          reviewer: 'reviewer-1',
          commit: binding.commit,
          verdict: 'pass',
          evidence: {
            A1: { kind: 'check', command: 'pnpm test', exitCode: 0, output: '', commit: binding.commit },
            A2: { kind: 'observation', text: 'No export changed' },
          },
          findings: '',
          at: 3,
        }),
      )
      binding.verdict = 'pass'

      return 'Signed off.'
    })
    const session = executor(store)
    await session.start()

    const result = (await session.tool('task_review', {})).content[0] as { text: string }

    expect(result.text).toContain('conflicted')
    expect(readState(store).tasks['T1']).toMatchObject({ state: 'claimed', base: { bookmark: 'main', commit: landed } })
  })

  it('sends its permission asks to whichever session holds the lease after a handoff', async () => {
    vi.stubEnv('PI_SUBAGENT_PARENT_SESSION', 'boss')
    const store = claimed(process.pid)
    const session = executor(store)
    await session.start()
    updateState(store, state => {
      state.lease = { sessionId: 'boss-2', pid: process.pid }
    })

    await session.emit('turn_start')

    expect(process.env['PI_SUBAGENT_PARENT_SESSION']).toBe('boss-2')
  })

  it('tells the coordinator when it exits', async () => {
    const session = executor(claimed(process.pid))
    await session.start()

    await session.emit('session_shutdown', { reason: 'quit' })

    expect(mailToCoordinator()).toMatchObject([{ wake: false, body: 'T1 executor exited; the task is claimed.' }])
  })
})
