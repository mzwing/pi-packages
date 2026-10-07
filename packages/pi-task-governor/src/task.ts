import type { GovernorConfig } from './config.js'

type TaskState = 'declared' | 'claimed' | 'reviewing' | 'done' | 'cancelled'

export interface Criterion {
  id: string
  statement: string
  /** Shell command the controller runs in the workspace; exit 0 means the criterion holds. */
  check?: string | undefined
}

export interface SpecInput {
  title: string
  problem: string
  scope: string
  boundary: string
  nonGoals: string[]
  acceptance: { statement: string; check?: string | undefined }[]
}

interface Spec {
  problem: string
  /** What the task changes: its intension. */
  scope: string
  /** Which code and behaviour it may reach: its extension. */
  boundary: string
  nonGoals: string[]
  acceptance: Criterion[]
}

export interface CheckEvidence {
  kind: 'check'
  command: string
  exitCode: number
  output: string
  commit: string
}

export type Evidence = CheckEvidence | { kind: 'observation'; text: string }

export interface Review {
  reviewer: string
  commit: string
  verdict: 'pass' | 'fail'
  evidence: Record<string, Evidence>
  findings: string
  at: number
}

/** Held by root tasks only; a subtask is worked by its root's executor in the root's workspace. */
export interface Claim {
  sessionId: string
  /** Of the executor process now running; a session presenting the id from another pid is not the claimer. */
  pid: number | undefined
  workspace: { name: string; path: string }
  /** Restarts after the executor stopped without finishing. */
  restarts: number
  question?: string | undefined
  answer?: string | undefined
  stalled?: string | undefined
}

export interface Task {
  id: string
  parentId?: string | undefined
  title: string
  spec: Spec
  /**
   * A root task branches from `bookmark` and merges back into it. `commit` is where the task's own changes start: pinned
   * when work on the task starts, and moved when a merge that did not land took in newer work from the bookmark.
   */
  base: { bookmark?: string | undefined; commit?: string | undefined }
  state: TaskState
  declaredBy: string
  claim?: Claim | undefined
  reviews: Review[]
  signedBy?: string | undefined
  signedCommit?: string | undefined
  merged?: string | undefined
  log: { at: number; event: string }[]
}

export interface State {
  seq: number
  /** `handoff` marks a lease the next session of the same TUI process takes over. */
  lease?: { sessionId: string; pid: number; handoff?: boolean | undefined } | undefined
  paused: boolean
  tasks: Record<string, Task>
  /** Session id to the time its git and jj unlock ends. */
  unlocks: Record<string, number>
  /** The coordinator's config; executors run where the project config is not trusted, so they read this copy. */
  config: GovernorConfig
}

export function emptyState(config: GovernorConfig): State {
  return { seq: 0, paused: false, tasks: {}, unlocks: {}, config }
}

export function isOpen(task: Task): boolean {
  return task.state !== 'done' && task.state !== 'cancelled'
}

function note(task: Task, event: string, now: number): void {
  task.log.push({ at: now, event })
}

export function requireTask(state: State, id: string): Task {
  const task = state.tasks[id]
  if (task === undefined) {
    throw new Error(`There is no task ${id}.`)
  }

  return task
}

function childrenOf(state: State, id: string): Task[] {
  return Object.values(state.tasks).filter(task => task.parentId === id)
}

/** The open root task an executor session works on. */
export function claimedRoot(state: State, sessionId: string): Task | undefined {
  return Object.values(state.tasks).find(
    task => task.parentId === undefined && isOpen(task) && task.claim?.sessionId === sessionId,
  )
}

function claimOf(state: State, task: Task): Claim | undefined {
  return task.parentId === undefined ? task.claim : claimOf(state, requireTask(state, task.parentId))
}

/** The deepest open task of a root's tree; depth-first work always happens there. */
export function focusOf(state: State, root: Task): Task {
  const child = childrenOf(state, root.id).find(isOpen)

  return child === undefined ? root : focusOf(state, child)
}

function buildSpec(input: SpecInput, globalChecks: GovernorConfig['globalChecks']): Spec {
  return {
    problem: input.problem,
    scope: input.scope,
    boundary: input.boundary,
    nonGoals: input.nonGoals,
    acceptance: [
      ...input.acceptance.map((criterion, index) => ({ id: `A${index + 1}`, ...criterion })),
      ...globalChecks.map((criterion, index) => ({ id: `G${index + 1}`, ...criterion })),
    ],
  }
}

export function declareRoot(state: State, input: SpecInput, bookmark: string, by: string, now: number): Task {
  state.seq += 1
  const task: Task = {
    id: `T${state.seq}`,
    title: input.title,
    spec: buildSpec(input, state.config.globalChecks),
    base: { bookmark },
    state: 'declared',
    declaredBy: by,
    reviews: [],
    log: [],
  }
  note(task, `declared by ${by}, to merge into ${bookmark}`, now)
  state.tasks[task.id] = task

  return task
}

/** A subtask is a rabbit hole of its parent: declared by the parent's executor, who dives in at once. */
export function declareChild(
  state: State,
  parentId: string,
  input: SpecInput,
  by: string,
  baseCommit: string,
  now: number,
): Task {
  const parent = requireTask(state, parentId)
  if (parent.state !== 'claimed' || claimOf(state, parent)?.sessionId !== by) {
    throw new Error(`Only the executor working on ${parentId} can open a subtask under it.`)
  }
  const task: Task = {
    id: `${parent.id}.${childrenOf(state, parent.id).length + 1}`,
    parentId,
    title: input.title,
    spec: buildSpec(input, state.config.globalChecks),
    base: { commit: baseCommit },
    state: 'claimed',
    declaredBy: by,
    reviews: [],
    log: [],
  }
  note(task, `declared by ${by} under ${parentId}, based on ${baseCommit}`, now)
  state.tasks[task.id] = task

  return task
}

export function claimRoot(state: State, id: string, claim: Claim, now: number): Task {
  const task = requireTask(state, id)
  if (task.parentId !== undefined || task.state !== 'declared') {
    throw new Error(`${id} is not a declared root task.`)
  }
  task.state = 'claimed'
  task.claim = claim
  note(task, `claimed by ${claim.sessionId}`, now)

  return task
}

export function beginReview(state: State, id: string, by: string, commit: string, now: number): Task {
  const task = requireTask(state, id)
  if (task.state !== 'claimed' || claimOf(state, task)?.sessionId !== by) {
    throw new Error(`${id} is not claimed by this session.`)
  }
  const open = childrenOf(state, id).filter(isOpen)
  if (open.length > 0) {
    throw new Error(`${id} still has open subtasks: ${open.map(child => child.id).join(', ')}.`)
  }
  task.state = 'reviewing'
  note(task, `review started on ${commit}`, now)

  return task
}

/** What stops `evidence` from signing `task` off at `commit`; empty when every criterion is covered. */
function missingEvidence(task: Task, evidence: Record<string, Evidence>, commit: string): string[] {
  return task.spec.acceptance.flatMap(criterion => {
    const item = evidence[criterion.id]
    if (criterion.check !== undefined) {
      return item?.kind === 'check' && item.exitCode === 0 && item.commit === commit
        ? []
        : [`${criterion.id} needs a passing run of its check on ${commit}`]
    }

    return item?.kind === 'observation' && item.text.trim() !== '' ? [] : [`${criterion.id} needs an observation`]
  })
}

/**
 * Records a reviewer's verdict. A pass needs evidence for every criterion and a reviewer who neither declared nor
 * claimed the task; it finishes a subtask, while a root task stays in review until it is merged.
 */
export function recordVerdict(state: State, id: string, review: Review): Task {
  const task = requireTask(state, id)
  if (task.state !== 'reviewing') {
    throw new Error(`${id} is not in review.`)
  }
  if (review.reviewer === task.declaredBy || review.reviewer === claimOf(state, task)?.sessionId) {
    throw new Error(`The session that declared or claimed ${id} cannot sign it off.`)
  }
  if (review.verdict === 'pass') {
    const missing = missingEvidence(task, review.evidence, review.commit)
    if (missing.length > 0) {
      throw new Error(`${id} cannot be signed off yet: ${missing.join('; ')}.`)
    }
  }
  task.reviews.push(review)
  if (review.verdict === 'fail') {
    task.state = 'claimed'
    note(task, `rejected by ${review.reviewer}: ${review.findings}`, review.at)

    return task
  }
  task.signedBy = review.reviewer
  task.signedCommit = review.commit
  note(task, `signed off by ${review.reviewer} on ${review.commit}`, review.at)
  if (task.parentId !== undefined) {
    task.state = 'done'
  }

  return task
}

export function completeMerge(state: State, id: string, commit: string, now: number): Task {
  const task = requireTask(state, id)
  task.state = 'done'
  task.merged = commit
  note(task, `merged into ${task.base.bookmark} as ${commit}`, now)

  return task
}

/**
 * Sends a task in review back to its executor, such as when its merge conflicts or its review ends unfinished. A merge
 * that took in newer work from the bookmark passes `onto`, so later reviews see only the task's own changes. Any other
 * task is left as it is, so a task cancelled meanwhile stays cancelled.
 */
export function reopen(state: State, id: string, reason: string, now: number, onto?: string): Task {
  const task = requireTask(state, id)
  if (task.state === 'reviewing') {
    task.state = 'claimed'
    task.signedBy = undefined
    task.signedCommit = undefined
    task.base.commit = onto ?? task.base.commit
    note(task, `reopened: ${reason}`, now)
  }

  return task
}

export function cancelTask(state: State, id: string, by: string, reason: string, now: number): Task[] {
  const task = requireTask(state, id)
  if (!isOpen(task)) {
    throw new Error(`${id} is already ${task.state}.`)
  }
  task.state = 'cancelled'
  note(task, `cancelled by ${by}: ${reason}`, now)

  return [
    task,
    ...childrenOf(state, id)
      .filter(isOpen)
      .flatMap(child => cancelTask(state, child.id, by, `its parent ${id} was cancelled`, now)),
  ]
}

export function renderBrief(state: State, task: Task): string {
  const parent = task.parentId === undefined ? undefined : requireTask(state, task.parentId)

  return [
    `${task.id}: ${task.title}`,
    ...(parent === undefined ? [] : [`Subtask of ${parent.id}: ${parent.title}`]),
    `Problem: ${task.spec.problem}`,
    `Scope (what this task changes): ${task.spec.scope}`,
    `Boundary (what it may reach): ${task.spec.boundary}`,
    'Non-goals:',
    ...task.spec.nonGoals.map(goal => `- ${goal}`),
    'Acceptance criteria:',
    ...task.spec.acceptance.map(
      criterion =>
        `- ${criterion.id}: ${criterion.statement}${criterion.check === undefined ? '' : ` (check: \`${criterion.check}\`)`}`,
    ),
  ].join('\n')
}

/** One line per task, children indented under their parent; `annotate` adds live facts such as process state. */
export function renderTree(state: State, annotate: (task: Task) => string): string {
  function lines(task: Task, depth: number): string[] {
    const extra = annotate(task)

    return [
      `${'  '.repeat(depth)}${task.id} [${task.state}] ${task.title}${extra === '' ? '' : ` · ${extra}`}`,
      ...childrenOf(state, task.id).flatMap(child => lines(child, depth + 1)),
    ]
  }
  const roots = Object.values(state.tasks).filter(task => task.parentId === undefined)

  return roots.length === 0 ? 'No tasks yet.' : roots.flatMap(root => lines(root, 0)).join('\n')
}
