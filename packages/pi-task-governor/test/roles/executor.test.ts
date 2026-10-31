import type { Mail } from '@mzwing/pi-session-hub/api'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/config.js'
import { runChild } from '../../src/sessions/children.js'
import { initStore, readState, storeDirectory, updateState } from '../../src/tasks/store.js'
import { claimRoot, declareRoot, recordVerdict } from '../../src/tasks/task.js'
import { saveEnvironment } from '../../src/workspace/env.js'
import { addWorkspace, bookmarkCommit } from '../../src/workspace/vcs.js'
import { DEAD_PID, PARSER_SPEC, useWorkspace } from '../helpers.js'
import { loadGovernor } from '../pi.js'

vi.mock(import('../../src/sessions/children.js'), async importOriginal => ({
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
      declareRoot(state, PARSER_SPEC, 'main', [], 'boss', 1)
      claimRoot(state, 'T1', { sessionId: 'executor-1', pid, workspace: { name: 'task-T1', path }, sessions: 0 }, 2)
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

  /** What the governor's handlers of `name` return, ignoring the ones with nothing to say. */
  async function boundary(session: ReturnType<typeof executor>, name: string, event: object): Promise<unknown> {
    return (await session.emit(name, event)).find(result => result !== undefined)
  }

  function mailToCoordinator(): Mail[] {
    const directory = join(workspace.agent, 'pi-session-hub', 'mail', 'boss')

    return existsSync(directory)
      ? readdirSync(directory).map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')) as Mail)
      : []
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
    expect(readState(store).tasks['T1']?.log.at(-1)?.event).toBe('asked: Which API version?')
    const [mail] = mailToCoordinator()
    expect(mail).toMatchObject({ from: 'executor-1', fromName: 'T1 executor', wake: true })
    expect(mail?.body).toContain('Which API version?')
    expect(await boundary(session, 'agent_before_settle', { outcome: 'completed' })).toBeUndefined()
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

  it('sends an unfinished run back to work a few times, then lets it end for a fresh session to take over', async () => {
    const store = claimed(process.pid)
    const session = executor(store)
    await session.start()

    expect(await boundary(session, 'agent_before_settle', { outcome: 'error' })).toBeUndefined()
    for (let nudge = 0; nudge < 3; nudge += 1) {
      const result = (await boundary(session, 'agent_before_settle', { outcome: 'completed' })) as {
        continue: boolean
        entries: { content: string }[]
      }
      expect(result.continue).toBe(true)
      expect(result.entries[0]?.content).toContain('T1 is still claimed')
      expect(result.entries[0]?.content).toContain('task_handoff')
    }
    expect(await boundary(session, 'agent_before_settle', { outcome: 'completed' })).toBeUndefined()

    expect(readState(store).tasks['T1']?.claim?.stalled).toBeUndefined()
    expect(mailToCoordinator()).toEqual([])
  })

  it('keeps a note on its current task, and hands the task off only once it has worked on it', async () => {
    const store = claimed(process.pid)
    const session = executor(store)
    await session.start()

    await session.tool('task_note', { note: 'Tokenizer done; tests remain.' })
    expect(readState(store).tasks['T1']?.note).toBe('Tokenizer done; tests remain.')
    await expect(session.tool('task_handoff', { note: 'Nothing yet.' })).rejects.toThrow('only after working')
    await session.emit('tool_execution_end', { toolName: 'task_develop', isError: false })
    await session.tool('task_handoff', { note: 'Tokenizer done; parser tests remain.' })

    expect(readState(store).tasks['T1']).toMatchObject({
      note: 'Tokenizer done; parser tests remain.',
      claim: { handoff: true },
    })
    expect(readState(store).tasks['T1']?.log.at(-1)?.event).toBe('executor session executor-1 handed off by choice')
    expect(await boundary(session, 'agent_before_settle', { outcome: 'completed' })).toBeUndefined()
  })

  it('is told to hand off near its turn limit, and hands off by itself at it', async () => {
    const store = claimed(process.pid)
    updateState(store, state => {
      state.config.roles.executor.maxTurns = 4
    })
    const session = executor(store)
    await session.start()
    await session.emit('tool_execution_end', { toolName: 'task_review', isError: false })

    const results: unknown[] = []
    // One past the limit, as the aborted run's last turn ends.
    for (let turn = 0; turn < 5; turn += 1) {
      results.push(await boundary(session, 'turn_end', {}))
    }

    expect(results).toEqual([
      undefined,
      { entries: [expect.objectContaining({ customType: 'pi-task-governor:nudge' })] },
      undefined,
      undefined,
      undefined,
    ])
    expect(session.abort).toHaveBeenCalledOnce()
    expect(readState(store).tasks['T1']?.claim?.handoff).toBe(true)
    expect(readState(store).tasks['T1']?.log.filter(entry => entry.event.includes('handed off'))).toMatchObject([
      { event: 'executor session executor-1 handed off after 4 turns' },
    ])
  })

  it('hands nothing more off once its task waits for the coordinator, and only stops at its limit', async () => {
    const store = claimed(process.pid)
    updateState(store, state => {
      state.config.roles.executor.maxTurns = 4
      state.tasks['T1']!.state = 'approving'
    })
    const session = executor(store)
    await session.start()
    await session.emit('tool_execution_end', { toolName: 'task_review', isError: false })

    await expect(session.tool('task_handoff', { note: 'Done.' })).rejects.toThrow('Nothing is left to hand off')
    for (let turn = 0; turn < 4; turn += 1) {
      expect(await boundary(session, 'turn_end', {})).toBeUndefined()
    }

    expect(session.abort).toHaveBeenCalledOnce()
    expect(readState(store).tasks['T1']?.claim?.handoff).toBeUndefined()
  })

  it('sends its task back to work when a review breaks off', async () => {
    const store = await underWay('a.txt', 'hello\n')
    const session = executor(store)
    await session.start()

    await expect(session.tool('task_review', {})).rejects.toThrow('model unavailable')

    expect(readState(store).tasks['T1']?.state).toBe('claimed')
    expect(readState(store).tasks['T1']?.log.at(-1)?.event).toBe('reopened: its review ended unfinished')
  })

  it("leaves a root task that passed its review to the coordinator's sign-off, merging nothing", async () => {
    const store = await underWay('a.txt', 'hello\n')
    const main = await bookmarkCommit(workspace.repo, 'main')
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

    expect(result.text).toContain("waits for the coordinator's sign-off")
    expect(readState(store).tasks['T1']?.state).toBe('approving')
    expect(await bookmarkCommit(workspace.repo, 'main')).toBe(main)
    expect(await boundary(session, 'agent_before_settle', { outcome: 'completed' })).toBeUndefined()
  })

  it('asks the coordinator how to go on once its task has failed its review three times in a row', async () => {
    const store = await underWay('a.txt', 'hello\n')
    const failing: typeof runChild = async (_ctx, { binding }) => {
      updateState(binding.store, state =>
        recordVerdict(state, binding.taskId, {
          reviewer: 'reviewer-1',
          commit: binding.commit,
          verdict: 'fail',
          evidence: {},
          findings: 'a.txt says hello, not hi',
          at: 3,
        }),
      )
      binding.verdict = 'fail'

      return 'Failed.'
    }
    const session = executor(store)
    await session.start()

    for (let review = 0; review < 2; review += 1) {
      vi.mocked(runChild).mockImplementationOnce(failing)
      expect(((await session.tool('task_review', {})).content[0] as { text: string }).text).toContain(
        'Send the developer back',
      )
    }
    vi.mocked(runChild).mockImplementationOnce(failing)
    const result = (await session.tool('task_review', {})).content[0] as { text: string }

    const question = 'T1 failed its review 3 times in a row; how should it go on? task_show T1 has its reviews.'
    expect(result.text).toContain('so the coordinator was asked how it should go on. End your run now')
    expect(readState(store).tasks['T1']?.claim?.question).toBe(question)
    expect(readState(store).tasks['T1']?.log.at(-1)?.event).toBe(`asked: ${question}`)
    const [mail] = mailToCoordinator()
    expect(mail?.wake).toBe(true)
    expect(mail?.body).toContain(`T1 asks: ${question}`)
    await expect(session.tool('task_develop', { instructions: 'Write hi' })).rejects.toThrow(
      "T1 waits for the coordinator's answer",
    )
    expect(await boundary(session, 'agent_before_settle', { outcome: 'completed' })).toBeUndefined()
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

  it('leaves its claim and tells the coordinator when it exits', async () => {
    const store = claimed(process.pid)
    const session = executor(store)
    await session.start()

    await session.emit('session_shutdown', { reason: 'quit' })

    expect(readState(store).tasks['T1']?.claim?.pid).toBeUndefined()
    expect(mailToCoordinator()).toMatchObject([{ wake: false, body: 'T1 executor exited; the task is claimed.' }])
  })
})
