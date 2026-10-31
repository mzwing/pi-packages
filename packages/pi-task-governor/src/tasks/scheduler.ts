import type { Host } from '../tooling.js'
import type { Claim, State, Task } from './task.js'
import { randomUUID } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isAlive, logPath, spawnSession } from '@mzwing/pi-session-hub/api'
import { executorPrompt, signOffRequest } from '../roles/prompts.js'
import { describeError } from '../tooling.js'
import { failedChecks } from '../workspace/checks.js'
import {
  environmentPath,
  loadEnvironment,
  prepareEnvironment,
  releaseEnvironment,
  saveEnvironment,
  temporaryDirectory,
} from '../workspace/env.js'
import {
  addWorkspace,
  bookmarkCommit,
  changedFiles,
  diff,
  headOf,
  landedAfter,
  mergeInto,
  removeWorkspace,
} from '../workspace/vcs.js'
import { readState, updateState } from './store.js'
import { claimRoot, completeMerge, focusOf, isOpen, logEvent, reopen, requireTask, waitsFor } from './task.js'

export const STORE_FLAG = 'governor-store'
const EXECUTOR_TOOLS: string[] = [
  'read',
  'grep',
  'find',
  'ls',
  'task_show',
  'task_subtask',
  'task_develop',
  'task_review',
  'task_note',
  'task_ask',
  'task_handoff',
  'session_read',
]
// Executor sessions a task gets between the coordinator's words on it, however each one ends
const MAX_SESSIONS = 3

export type ExecutorStatus = 'preparing' | 'running' | 'asking' | 'handed-off' | 'stalled' | 'stopped'

export interface Scheduler {
  /** Brings executors in line with the store; calls during a pass fold into one more pass */
  tick: () => void
}

export function executorStatus(claim: Claim): ExecutorStatus {
  if (claim.stalled !== undefined) {
    return 'stalled'
  }
  if (claim.sessionId === undefined) {
    return 'preparing'
  }
  if (claim.pid !== undefined && isAlive(claim.pid)) {
    return 'running'
  }
  if (claim.question !== undefined) {
    return 'asking'
  }

  return claim.handoff === true ? 'handed-off' : 'stopped'
}

function sequence(task: Task): number {
  return Number(task.id.slice(1))
}

/**
 * The other root tasks of `task`'s bookmark that change files it changes, with those files: the ones merged since it
 * started, and the open ones with a workspace. A task's own changes run from its base to its head, which is its merge
 * once it has landed
 */
async function overlappingTasks(
  repoRoot: string,
  state: State,
  task: Task,
): Promise<{ task: Task; files: string[] }[]> {
  const base = task.base.commit!
  const own = new Set(await changedFiles(repoRoot, base, task.signedCommit!))
  const others = Object.values(state.tasks).filter(
    other => other.parentId === undefined && other.id !== task.id && other.base.bookmark === task.base.bookmark,
  )
  const merged = others.filter(other => other.state === 'done')
  const landed = await landedAfter(
    repoRoot,
    base,
    task.base.bookmark!,
    merged.map(other => other.merged!),
  )
  const overlapWith = async (other: Task, head: string): Promise<{ task: Task; files: string[] }> => ({
    task: other,
    files: (await changedFiles(repoRoot, other.base.commit!, head)).filter(file => own.has(file)),
  })
  const overlaps = await Promise.all([
    ...merged.filter(other => landed.includes(other.merged!)).map(async other => overlapWith(other, other.merged!)),
    ...others
      .filter(other => isOpen(other) && other.claim?.sessionId !== undefined)
      .map(async other => overlapWith(other, await headOf(repoRoot, other.claim!.workspace))),
  ])

  return overlaps.filter(overlap => overlap.files.length > 0)
}

/**
 * Runs in the coordinator, woken by events only: declarations, answers, sign-offs, executor exits and executor mail.
 * It launches executors for root tasks whose turn has come within the budget, gives a task a fresh executor session
 * whenever the last one ended before the task did until it runs out of sessions, asks the coordinator to sign off what
 * passed review and merges what it approved, and removes the workspaces of finished tasks
 */
export function createScheduler(host: Host, notify: (message: string, wake: boolean) => void): Scheduler {
  let pass: Promise<void> | undefined
  let again = false
  // By task and review, so a task that passes again is asked about again; a new coordinator session asks anew
  const requested = new Set<string>()
  // One merge at a time, so tasks never race each other for the bookmark; the next starts when it ends
  let merging = false

  function stall(store: string, taskId: string, reason: string): void {
    updateState(store, state => {
      requireTask(state, taskId).claim!.stalled = reason
    })
    notify(`${taskId} stalled: ${reason}`, true)
  }

  /**
   * Starts a fresh executor session, which takes over from the last one if any. Spawning inside the lock means the
   * executor, which checks its pid under the same lock, sees it bound
   */
  function launch(store: string, taskId: string): void {
    updateState(store, state => {
      const task = requireTask(state, taskId)
      // Cancelled while its workspace was being prepared
      if (!isOpen(task)) {
        return
      }
      const claim = task.claim!
      const prompt = executorPrompt(state, task, claim.sessionId)
      claim.sessionId = randomUUID()
      const { model, thinking } = state.config.roles.executor
      const child = spawnSession({
        cwd: claim.workspace.path,
        sessionId: claim.sessionId,
        prompt,
        name: `${task.id} executor: ${task.title}`,
        model,
        thinking,
        tools: EXECUTOR_TOOLS,
        // `--tools` alone keeps MCP tools, which the executor's fixed tool set leaves out
        args: ['--no-approve', '--no-mcp', `--${STORE_FLAG}`, store],
        // Pi's own temporary files, and the in-process developers and reviewers, use it too
        env: { TMPDIR: temporaryDirectory(claim.workspace.path) },
        // So what would ask in the executor, or in its developers and reviewers, is answered by the coordinator
        parentSessionId: state.lease!.sessionId,
      })
      if (child.pid === undefined) {
        claim.stalled = `pi could not start; see ${logPath(claim.sessionId)}`

        return
      }
      child.on('exit', tick)
      child.unref()
      claim.pid = child.pid
      claim.sessions += 1
      claim.handoff = undefined
      logEvent(task, `executor session ${claim.sessionId} started`, Date.now())
    })
  }

  async function start(store: string, repoRoot: string, taskId: string): Promise<void> {
    const { config } = readState(store)
    const workspaceRoot = resolve(repoRoot, config.workspaceRoot ?? `${repoRoot}.tasks`)
    const workspace = { name: `task-${taskId}`, path: join(workspaceRoot, taskId) }
    const bookmark = updateState(store, state => {
      const task = claimRoot(
        state,
        taskId,
        { sessionId: undefined, pid: undefined, workspace, sessions: 0 },
        Date.now(),
      )

      return task.base.bookmark!
    })
    try {
      const base = await bookmarkCommit(repoRoot, bookmark)
      updateState(store, state => {
        requireTask(state, taskId).base.commit = base
      })
      await addWorkspace(repoRoot, workspace, base)
      saveEnvironment(store, taskId, await prepareEnvironment(workspace.path, config.env.provider, config.env.setup))
    } catch (error) {
      stall(store, taskId, `preparing its workspace failed: ${describeError(error)}`)

      return
    }
    launch(store, taskId)
  }

  function relaunch(store: string, task: Task, status: ExecutorStatus): void {
    if (task.claim!.sessions === MAX_SESSIONS) {
      stall(
        store,
        task.id,
        `it went through ${MAX_SESSIONS} executor sessions since your last word on it, and the last one ${status === 'stopped' ? 'stopped before the task ended' : 'handed off'}`,
      )

      return
    }
    updateState(store, state => {
      const root = requireTask(state, task.id)
      // A review the stopped executor was running died with it
      reopen(state, focusOf(state, root).id, 'its executor stopped during the review', Date.now())
    })
    launch(store, task.id)
  }

  async function requestSignOff(repoRoot: string, state: State, task: Task): Promise<void> {
    const [base, head] = [task.base.commit!, task.signedCommit!]
    const [stat, change, overlapping] = await Promise.all([
      diff(repoRoot, base, head, true),
      diff(repoRoot, base, head, false),
      overlappingTasks(repoRoot, state, task),
    ])
    notify(signOffRequest(state, task, stat, change, overlapping), true)
  }

  function returnFromMerge(store: string, taskId: string, reason: string, onto?: string): void {
    updateState(store, state => reopen(state, taskId, reason, Date.now(), onto))
    notify(`${taskId} went back to its executor: ${reason}`, false)
  }

  /** Merges an approved task exactly as its reviewer signed it off, re-running its checks on a rebased head */
  async function merge(store: string, repoRoot: string, task: Task): Promise<void> {
    const { workspace } = task.claim!
    const bookmark = task.base.bookmark!
    try {
      if ((await headOf(repoRoot, workspace)) !== task.signedCommit) {
        returnFromMerge(store, task.id, 'its workspace changed after its review')

        return
      }
      const checks = { store, environment: loadEnvironment(store, task.id).changes }
      const result = await mergeInto(repoRoot, workspace, bookmark, task.approval!.commitMessage, async () =>
        failedChecks(checks, workspace, task.spec.acceptance, await headOf(repoRoot, workspace)),
      )
      switch (result.kind) {
        case 'merged': {
          const finished = updateState(store, state => {
            completeMerge(state, task.id, result.commit, result.onto, Date.now())

            return Object.values(state.tasks).every(other => !isOpen(other))
          })
          // Only the merge that finishes the last task wakes the coordinator, which may owe the user its outcome
          notify(
            finished
              ? `${task.id} is merged into ${bookmark}, and every task is finished.`
              : `${task.id} is merged into ${bookmark}.`,
            finished,
          )
          break
        }
        case 'conflicted':
          returnFromMerge(
            store,
            task.id,
            `merging into ${bookmark} conflicted; the workspace holds the conflict markers`,
            result.onto,
          )
          break
        case 'failed-checks':
          returnFromMerge(
            store,
            task.id,
            `its checks failed after rebasing onto ${bookmark}:\n${result.detail}`,
            result.onto,
          )
          break
      }
    } catch (error) {
      updateState(store, state => {
        requireTask(state, task.id).approval = undefined
      })
      notify(
        `Merging ${task.id} into ${bookmark} failed: ${describeError(error)}\nApprove it again to retry, or send it back with task_reject.`,
        true,
      )
    }
  }

  async function cleanUp(store: string, repoRoot: string, task: Task): Promise<void> {
    const { workspace } = task.claim!
    await removeWorkspace(repoRoot, workspace)
    rmSync(temporaryDirectory(workspace.path), { recursive: true, force: true })
    if (existsSync(environmentPath(store, task.id))) {
      await releaseEnvironment(loadEnvironment(store, task.id))
    }
  }

  async function run(): Promise<void> {
    const runtime = host.runtime()
    if (runtime?.role !== 'coordinator') {
      return
    }
    const { store, repoRoot } = runtime
    const state = readState(store)
    const roots = Object.values(state.tasks).filter(task => task.parentId === undefined)
    const finished = roots.filter(
      task =>
        !isOpen(task) &&
        task.claim !== undefined &&
        existsSync(task.claim.workspace.path) &&
        executorStatus(task.claim) !== 'running',
    )
    for (const task of finished) {
      try {
        await cleanUp(store, repoRoot, task)
      } catch (error) {
        notify(`Cleaning up after ${task.id} failed: ${describeError(error)}`, false)
      }
    }
    for (const task of roots.filter(root => root.state === 'approving')) {
      const request = `${task.id}:${task.reviews.length}`
      if (task.approval === undefined && !requested.has(request)) {
        requested.add(request)
        await requestSignOff(repoRoot, state, task)
      } else if (task.approval !== undefined && !merging) {
        merging = true
        void merge(store, repoRoot, task).finally(() => {
          merging = false
          tick()
        })
      }
    }
    if (state.paused) {
      return
    }
    for (const task of roots) {
      const status =
        task.claim === undefined || !isOpen(task) || task.state === 'approving' ? undefined : executorStatus(task.claim)
      if (status === 'stopped' || status === 'handed-off') {
        relaunch(store, task, status)
      }
    }
    const busy = Object.values(readState(store).tasks).filter(
      task => isOpen(task) && task.claim !== undefined && ['preparing', 'running'].includes(executorStatus(task.claim)),
    ).length
    const queued = roots
      .filter(task => task.state === 'declared' && waitsFor(state, task).length === 0)
      .sort((left, right) => sequence(left) - sequence(right))
      .slice(0, Math.max(0, state.config.maxExecutors - busy))
    await Promise.all(queued.map(async task => start(store, repoRoot, task.id)))
    host.changed()
  }

  function tick(): void {
    if (pass !== undefined) {
      again = true

      return
    }
    pass = (async () => {
      do {
        again = false
        await run()
      } while (again)
    })()
      .catch((error: unknown) => notify(`The task scheduler failed: ${describeError(error)}`, true))
      .finally(() => {
        pass = undefined
      })
  }

  return { tick }
}
