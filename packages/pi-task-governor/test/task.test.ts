import type { Claim, Evidence, Review, State } from '../src/task.js'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import {
  beginReview,
  cancelTask,
  claimRoot,
  completeMerge,
  declareChild,
  declareRoot,
  emptyState,
  focusOf,
  recordVerdict,
  renderBrief,
  renderTree,
  reopen,
} from '../src/task.js'
import { PARSER_SPEC } from './helpers.js'

const CLAIM: Claim = { sessionId: 'executor', pid: 1, workspace: { name: 'T1', path: '/ws/T1' }, restarts: 0 }

function state(): State {
  return emptyState({ ...DEFAULT_CONFIG, globalChecks: [{ statement: 'Lint passes', check: 'pnpm lint' }] })
}

function claimed(): State {
  const current = state()
  declareRoot(current, PARSER_SPEC, 'main', 'coordinator', 1)
  claimRoot(current, 'T1', CLAIM, 2)

  return current
}

function passingEvidence(commit: string): Record<string, Evidence> {
  return {
    A1: { kind: 'check', command: 'pnpm test', exitCode: 0, output: 'ok', commit },
    A2: { kind: 'observation', text: 'Exports unchanged in src/index.ts' },
    G1: { kind: 'check', command: 'pnpm lint', exitCode: 0, output: 'ok', commit },
  }
}

function review(overrides: Partial<Review> = {}): Review {
  return {
    reviewer: 'reviewer',
    commit: 'c1',
    verdict: 'pass',
    evidence: passingEvidence('c1'),
    findings: '',
    at: 3,
    ...overrides,
  }
}

describe('declaring tasks', () => {
  it('numbers root tasks and appends the global checks to the acceptance criteria', () => {
    const current = state()
    declareRoot(current, PARSER_SPEC, 'main', 'coordinator', 1)
    const second = declareRoot(current, PARSER_SPEC, 'dev', 'coordinator', 1)

    expect(second).toMatchObject({ id: 'T2', state: 'declared', base: { bookmark: 'dev' }, declaredBy: 'coordinator' })
    expect(second.spec.acceptance.map(criterion => criterion.id)).toEqual(['A1', 'A2', 'G1'])
  })

  it('lets only the claiming executor open a subtask, which it works at once', () => {
    const current = claimed()

    expect(() => declareChild(current, 'T1', PARSER_SPEC, 'someone-else', 'c0', 3)).toThrow('Only the executor')
    const child = declareChild(current, 'T1', PARSER_SPEC, 'executor', 'c0', 3)
    const grandchild = declareChild(current, 'T1.1', PARSER_SPEC, 'executor', 'c1', 4)

    expect(child).toMatchObject({ id: 'T1.1', parentId: 'T1', state: 'claimed', base: { commit: 'c0' } })
    expect(grandchild.id).toBe('T1.1.1')
    expect(focusOf(current, current.tasks['T1']!).id).toBe('T1.1.1')
  })
})

describe('reviewing tasks', () => {
  it('keeps a parent out of review while a subtask is open', () => {
    const current = claimed()
    declareChild(current, 'T1', PARSER_SPEC, 'executor', 'c0', 3)

    expect(() => beginReview(current, 'T1', 'executor', 'c1', 4)).toThrow('open subtasks: T1.1')
    expect(() => beginReview(current, 'T1.1', 'intruder', 'c1', 4)).toThrow('not claimed by this session')
  })

  it('refuses a sign-off by the session that declared or claimed the task', () => {
    const current = claimed()
    beginReview(current, 'T1', 'executor', 'c1', 3)

    expect(() => recordVerdict(current, 'T1', review({ reviewer: 'coordinator' }))).toThrow('cannot sign it off')
    expect(() => recordVerdict(current, 'T1', review({ reviewer: 'executor' }))).toThrow('cannot sign it off')
  })

  it('refuses a pass whose evidence misses, fails or predates a criterion', () => {
    const current = claimed()
    beginReview(current, 'T1', 'executor', 'c1', 3)
    const { A1: _check, ...withoutA1 } = passingEvidence('c1')

    expect(() =>
      recordVerdict(
        current,
        'T1',
        review({
          evidence: {
            ...withoutA1,
            A2: { kind: 'observation', text: ' ' },
            G1: { kind: 'check', command: 'pnpm lint', exitCode: 0, output: '', commit: 'c0' },
          },
        }),
      ),
    ).toThrow(
      'A1 needs a passing run of its check on c1; A2 needs an observation; G1 needs a passing run of its check on c1',
    )
    expect(current.tasks['T1']?.state).toBe('reviewing')
  })

  it('sends a failed review back to the executor', () => {
    const current = claimed()
    beginReview(current, 'T1', 'executor', 'c1', 3)
    recordVerdict(current, 'T1', review({ verdict: 'fail', evidence: {}, findings: 'Edge case missed' }))

    expect(current.tasks['T1']).toMatchObject({ state: 'claimed', reviews: [{ verdict: 'fail' }] })
  })

  it('finishes a signed subtask at once and a signed root task only once merged', () => {
    const current = claimed()
    declareChild(current, 'T1', PARSER_SPEC, 'executor', 'c0', 3)
    beginReview(current, 'T1.1', 'executor', 'c1', 4)
    recordVerdict(current, 'T1.1', review())
    beginReview(current, 'T1', 'executor', 'c2', 5)
    recordVerdict(current, 'T1', review({ commit: 'c2', evidence: passingEvidence('c2') }))

    expect(current.tasks['T1.1']?.state).toBe('done')
    expect(current.tasks['T1']).toMatchObject({ state: 'reviewing', signedBy: 'reviewer', signedCommit: 'c2' })
    completeMerge(current, 'T1', 'c3', 6)
    expect(current.tasks['T1']).toMatchObject({ state: 'done', merged: 'c3' })
  })

  it('reopens a signed root task whose merge conflicts onto what it took in, but not one cancelled meanwhile', () => {
    const current = claimed()
    beginReview(current, 'T1', 'executor', 'c1', 3)
    recordVerdict(current, 'T1', review())
    reopen(current, 'T1', 'conflicts with main', 4, 'main2')

    expect(current.tasks['T1']).toMatchObject({
      state: 'claimed',
      signedBy: undefined,
      signedCommit: undefined,
      base: { bookmark: 'main', commit: 'main2' },
    })
    expect(current.tasks['T1']?.log.at(-1)?.event).toBe('reopened: conflicts with main')
    beginReview(current, 'T1', 'executor', 'c2', 5)
    cancelTask(current, 'T1', 'coordinator', 'not needed', 6)
    expect(reopen(current, 'T1', 'its review ended unfinished', 7).state).toBe('cancelled')
  })
})

it('cancels a task together with its open subtasks', () => {
  const current = claimed()
  declareChild(current, 'T1', PARSER_SPEC, 'executor', 'c0', 3)
  declareChild(current, 'T1.1', PARSER_SPEC, 'executor', 'c0', 3)

  expect(cancelTask(current, 'T1', 'coordinator', 'not needed', 4).map(task => task.id)).toEqual([
    'T1',
    'T1.1',
    'T1.1.1',
  ])
  expect(() => cancelTask(current, 'T1.1', 'coordinator', 'again', 5)).toThrow('already cancelled')
})

it('renders a brief and a tree for the sessions that read them', () => {
  const current = claimed()
  declareChild(current, 'T1', { ...PARSER_SPEC, title: 'Handle CR alone' }, 'executor', 'c0', 3)

  expect(renderBrief(current, current.tasks['T1.1']!)).toBe(
    [
      'T1.1: Handle CR alone',
      'Subtask of T1: Fix the parser',
      'Problem: CRLF input breaks parsing',
      'Scope (what this task changes): Normalise line endings in the tokenizer',
      'Boundary (what it may reach): src/parser only',
      'Non-goals:',
      '- Rewriting the grammar',
      'Acceptance criteria:',
      '- A1: Tests pass (check: `pnpm test`)',
      '- A2: No API change',
      '- G1: Lint passes (check: `pnpm lint`)',
    ].join('\n'),
  )
  expect(renderTree(current, task => (task.id === 'T1' ? 'running' : ''))).toBe(
    'T1 [claimed] Fix the parser · running\n  T1.1 [claimed] Handle CR alone',
  )
})
