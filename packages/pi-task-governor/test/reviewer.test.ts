import type { ChildBinding } from '../src/children.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import { initStore, readState, storeDirectory, updateState } from '../src/store.js'
import { beginReview, claimRoot, declareRoot } from '../src/task.js'
import { addWorkspace, bookmarkCommit, commitWorkingCopy, headOf } from '../src/vcs.js'
import { ADD_FILE_SPEC, useWorkspace } from './helpers.js'
import { loadGovernor } from './pi.js'

function bindings(): Map<string, ChildBinding> {
  const global = globalThis as Record<symbol, Map<string, ChildBinding> | undefined>
  global[Symbol.for('pi-task-governor:children')] ??= new Map()

  return global[Symbol.for('pi-task-governor:children')]!
}

describe('reviewer session', () => {
  const workspace = useWorkspace()

  afterEach(() => {
    bindings().clear()
  })

  async function underReview(): Promise<{ store: string; binding: ChildBinding }> {
    const store = storeDirectory(workspace.repo)
    initStore(store, DEFAULT_CONFIG)
    const task = { name: 'task-T1', path: join(workspace.root, 'repo.tasks', 'T1') }
    const base = await bookmarkCommit(workspace.repo, 'main')
    await addWorkspace(workspace.repo, task, base)
    writeFileSync(join(task.path, 'a.txt'), 'hello\n')
    await commitWorkingCopy(task, 'T1: add a.txt')
    const head = await headOf(workspace.repo, task)
    updateState(store, state => {
      state.lease = { sessionId: 'boss', pid: process.pid }
      declareRoot(state, ADD_FILE_SPEC, 'main', 'boss', 1)
      claimRoot(state, 'T1', { sessionId: 'executor-1', pid: process.pid, workspace: task, restarts: 0 }, 2)
      state.tasks['T1']!.base.commit = base
      beginReview(state, 'T1', 'executor-1', head, 3)
    })
    const binding: ChildBinding = {
      role: 'reviewer',
      store,
      taskId: 'T1',
      workspace: task,
      environment: {},
      commit: head,
      checks: {},
    }
    bindings().set('reviewer-1', binding)

    return { store, binding }
  }

  async function reviewer() {
    const session = loadGovernor({ cwd: workspace.root, sessionId: 'reviewer-1', mode: 'print' })
    await session.start()

    return session
  }

  it('shows the change under review and records check runs as evidence', async () => {
    const { binding } = await underReview()
    const session = await reviewer()

    const diff = (await session.tool('task_diff', {})).content[0] as { text: string }
    const check = (await session.tool('task_check', { criterion: 'A1' })).content[0] as { text: string }

    expect(diff.text).toContain('+hello')
    expect(check.text).toBe('A1 (`test -f a.txt`) exited 0:\n')
    expect(binding.checks['A1']).toMatchObject({ kind: 'check', exitCode: 0, commit: binding.commit })
    await expect(session.tool('task_check', { criterion: 'A2' })).rejects.toThrow('judge it by observation')
  })

  it('fails a check that rewrites tracked files, and puts them back', async () => {
    const { binding } = await underReview()
    updateState(binding.store, state => {
      state.tasks['T1']!.spec.acceptance[0]!.check = 'echo tampered > a.txt'
    })
    const session = await reviewer()

    await session.tool('task_check', { criterion: 'A1' })

    expect(binding.checks['A1']?.exitCode).toBe(1)
    expect(binding.checks['A1']?.output).toContain('changed tracked files')
    expect(readFileSync(join(binding.workspace.path, 'a.txt'), 'utf8')).toBe('hello\n')
  })

  it('signs off only with evidence for every criterion, and a failure only with findings', async () => {
    const { store, binding } = await underReview()
    const session = await reviewer()
    await session.tool('task_check', { criterion: 'A1' })

    await expect(session.tool('task_verdict', { verdict: 'pass' })).rejects.toThrow('A2 needs an observation')
    await expect(session.tool('task_verdict', { verdict: 'fail' })).rejects.toThrow('needs findings')
    await session.tool('task_verdict', {
      verdict: 'pass',
      observations: [
        { criterion: 'A1', text: 'not a substitute for the check run' },
        { criterion: 'A2', text: 'a.txt line 1 reads hello' },
      ],
    })

    expect(binding.verdict).toBe('pass')
    expect(readState(store).tasks['T1']).toMatchObject({
      state: 'reviewing',
      signedBy: 'reviewer-1',
      signedCommit: binding.commit,
      reviews: [{ evidence: { A1: { kind: 'check' }, A2: { kind: 'observation' } } }],
    })
  })

  it('asks a reviewer that stops without a verdict for one, once', async () => {
    await underReview()
    const session = await reviewer()
    const settle = async (): Promise<unknown> =>
      (await session.emit('agent_before_settle', { outcome: 'completed' })).find(result => result !== undefined)

    expect(await settle()).toMatchObject({ continue: true, entries: [{ customType: 'pi-task-governor:nudge' }] })
    expect(await settle()).toBeUndefined()
  })
})
