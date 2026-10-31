import type { GovernorConfig } from './config.js'

type TaskState = 'declared' | 'claimed' | 'reviewing' | 'approving' | 'done' | 'cancelled'

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
  /** Of the executor session working the task, or of the last one; undefined until the first starts. */
  sessionId: string | undefined
  /** Of the executor process while it runs; a session presenting the id from another pid is not the claimer. */
  pid: number | undefined
  workspace: { name: string; path: string }
  /** Executor sessions started since the coordinator last answered, revised, approved or sent back the task. */
  sessions: number
  question?: string | undefined
  stalled?: string | undefined
  /**
   * The last executor session ended on purpose rather than giving up: it handed off, the coordinator answered it, or
   * the task came back. The task's log tells the new session which.
   */
  handoff?: boolean | undefined
}

export interface Task {
  id: string
  parentId?: string | undefined
  title: string
  spec: Spec
  /**
   * A root task branches from `bookmark` and merges back into it. `commit` is where the task's own changes start: pinned
   * when work on the task starts, and moved whenever a merge, landed or not, takes in newer work from the bookmark.
   */
  base: { bookmark?: string | undefined; commit?: string | undefined }
  /** Root tasks of the same bookmark that must be merged before this one starts. */
  after?: string[] | undefined
  state: TaskState
  declaredBy: string
  claim?: Claim | undefined
  /** What the executor carries to whoever works the task next. */
  note?: string | undefined
  reviews: Review[]
  signedBy?: string | undefined
  signedCommit?: string | undefined
  /** The coordinator session's sign-off of a reviewed root task, with the message its commit lands with. */
  approval?: { by: string; commitMessage: string } | undefined
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

export function logEvent(task: Task, event: string, now: number): void {
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

export function rootOf(state: State, task: Task): Task {
  return task.parentId === undefined ? task : rootOf(state, requireTask(state, task.parentId))
}

function claimOf(state: State, task: Task): Claim | undefined {
  return rootOf(state, task).claim
}

/** The open tasks from a root down to the deepest one, where depth-first work always happens. */
export function focusChain(state: State, root: Task): Task[] {
  const child = childrenOf(state, root.id).find(isOpen)

  return child === undefined ? [root] : [root, ...focusChain(state, child)]
}

export function focusOf(state: State, root: Task): Task {
  return focusChain(state, root).at(-1)!
}

/** The tasks a declared root task still waits for. */
export function waitsFor(state: State, task: Task): string[] {
  return (task.after ?? []).filter(id => requireTask(state, id).state !== 'done')
}

function criteria(acceptance: SpecInput['acceptance'], globalChecks: GovernorConfig['globalChecks']): Criterion[] {
  return [
    ...acceptance.map((criterion, index) => ({ id: `A${index + 1}`, ...criterion })),
    ...globalChecks.map((criterion, index) => ({ id: `G${index + 1}`, ...criterion })),
  ]
}

function buildSpec(input: SpecInput, globalChecks: GovernorConfig['globalChecks']): Spec {
  return {
    problem: input.problem,
    scope: input.scope,
    boundary: input.boundary,
    nonGoals: input.nonGoals,
    acceptance: criteria(input.acceptance, globalChecks),
  }
}

/** Replaces the parts of a task's brief that `changes` gives; a new list of criteria is numbered afresh. */
export function reviseBrief(state: State, task: Task, changes: Partial<SpecInput>): void {
  const { title = task.title, acceptance, ...brief } = changes
  task.title = title
  task.spec = {
    ...task.spec,
    ...brief,
    ...(acceptance === undefined ? {} : { acceptance: criteria(acceptance, state.config.globalChecks) }),
  }
}

/** Waiting for a root task of the same bookmark means starting from a bookmark that holds its merge. */
export function declareRoot(
  state: State,
  input: SpecInput,
  bookmark: string,
  after: string[],
  by: string,
  now: number,
): Task {
  for (const id of after) {
    const other = requireTask(state, id)
    if (other.parentId !== undefined || other.state === 'cancelled' || other.base.bookmark !== bookmark) {
      throw new Error(
        `A task can only wait for root tasks that merge into ${bookmark} and are not cancelled; ${id} is not one.`,
      )
    }
  }
  state.seq += 1
  const task: Task = {
    id: `T${state.seq}`,
    title: input.title,
    spec: buildSpec(input, state.config.globalChecks),
    base: { bookmark },
    after,
    state: 'declared',
    declaredBy: by,
    reviews: [],
    log: [],
  }
  logEvent(
    task,
    `declared by ${by}, to merge into ${bookmark}${after.length === 0 ? '' : ` after ${after.join(', ')}`}`,
    now,
  )
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
  logEvent(task, `declared by ${by} under ${parentId}, based on ${baseCommit}`, now)
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
  logEvent(task, 'claimed', now)

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
  logEvent(task, `review started on ${commit}`, now)

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
 * claimed the task; it finishes a subtask, while a root task then waits for the coordinator's sign-off.
 */
export function recordVerdict(state: State, id: string, review: Review): Task {
  const task = requireTask(state, id)
  if (task.state !== 'reviewing') {
    throw new Error(`${id} is not in review.`)
  }
  if (review.reviewer === task.declaredBy || review.reviewer === claimOf(state, task)?.sessionId) {
    throw new Error(`The session that declared or claimed ${id} cannot review it.`)
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
    logEvent(task, `rejected by ${review.reviewer}: ${review.findings}`, review.at)

    return task
  }
  task.signedBy = review.reviewer
  task.signedCommit = review.commit
  task.state = task.parentId === undefined ? 'approving' : 'done'
  logEvent(task, `signed off by ${review.reviewer} on ${review.commit}`, review.at)

  return task
}

/** The reviews a task failed since it last passed one, the coordinator's refusals included. */
export function failedReviewsInARow(task: Task): number {
  return task.reviews.length - 1 - task.reviews.findLastIndex(review => review.verdict === 'pass')
}

function awaitingSignOff(state: State, id: string): Task {
  const task = requireTask(state, id)
  if (task.state !== 'approving' || task.approval !== undefined) {
    throw new Error(`${id} is not waiting for a sign-off.`)
  }

  return task
}

/** The coordinator's sign-off, after which the scheduler merges the task with `commitMessage`. */
export function approve(state: State, id: string, by: string, commitMessage: string, now: number): Task {
  const task = awaitingSignOff(state, id)
  task.approval = { by, commitMessage }
  task.claim!.sessions = 0
  logEvent(task, `approved by ${by}`, now)

  return task
}

/** The coordinator's refusal to sign off, kept as a failed review of the commit it was shown. */
export function sendBack(state: State, id: string, by: string, findings: string, now: number): Task {
  const task = awaitingSignOff(state, id)
  task.reviews.push({ reviewer: by, commit: task.signedCommit!, verdict: 'fail', evidence: {}, findings, at: now })
  task.claim!.sessions = 0

  return reopen(state, id, `sent back by ${by}: ${findings}`, now)
}

/** `onto` is the bookmark commit the task landed on, where its own changes start. */
export function completeMerge(state: State, id: string, commit: string, onto: string, now: number): Task {
  const task = requireTask(state, id)
  task.state = 'done'
  task.merged = commit
  task.base.commit = onto
  logEvent(task, `merged into ${task.base.bookmark} as ${commit}`, now)

  return task
}

/**
 * Sends a task in review, or waiting for sign-off, back to its executor, such as when its merge conflicts or its review
 * ends unfinished. One waiting for sign-off has no executor left, so a fresh session takes it up. A merge that took in
 * newer work from the bookmark passes `onto`, so later reviews see only the task's own changes. Any other task is left
 * as it is, so a task cancelled meanwhile stays cancelled.
 */
export function reopen(state: State, id: string, reason: string, now: number, onto?: string): Task {
  const task = requireTask(state, id)
  if (task.state === 'approving') {
    task.claim!.handoff = true
  }
  if (task.state === 'reviewing' || task.state === 'approving') {
    task.state = 'claimed'
    task.signedBy = undefined
    task.signedCommit = undefined
    task.approval = undefined
    task.base.commit = onto ?? task.base.commit
    logEvent(task, `reopened: ${reason}`, now)
  }

  return task
}

/** Cancels a task together with its open subtasks and the declared tasks that wait for it. */
export function cancelTask(state: State, id: string, by: string, reason: string, now: number): Task[] {
  const task = requireTask(state, id)
  if (!isOpen(task)) {
    throw new Error(`${id} is already ${task.state}.`)
  }
  task.state = 'cancelled'
  logEvent(task, `cancelled by ${by}: ${reason}`, now)
  const dependents = Object.values(state.tasks).filter(other => other.after?.includes(id) === true)

  return [
    task,
    ...childrenOf(state, id)
      .filter(isOpen)
      .flatMap(child => cancelTask(state, child.id, by, `its parent ${id} was cancelled`, now)),
    // Checked as each one comes up, since cancelling an earlier one can reach it through another task it waits for.
    ...dependents.flatMap(dependent =>
      isOpen(dependent) ? cancelTask(state, dependent.id, by, `it waited for ${id}, which was cancelled`, now) : [],
    ),
  ]
}

export function renderBrief(state: State, task: Task): string {
  const parent = task.parentId === undefined ? undefined : requireTask(state, task.parentId)
  const after = task.after ?? []

  return [
    `${task.id}: ${task.title}`,
    ...(parent === undefined ? [] : [`Subtask of ${parent.id}: ${parent.title}`]),
    ...(after.length === 0
      ? []
      : [
          'Builds on these tasks, merged before it starts:',
          ...after.map(id => `- ${id}: ${requireTask(state, id).title}`),
        ]),
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
