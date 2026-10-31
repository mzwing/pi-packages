import type { Runtime } from '../sessions/runtime.js'
import type { State, Task } from '../tasks/task.js'
import type { Host } from '../tooling.js'
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import process from 'node:process'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { loadConfig } from '../config.js'
import { leaseIsFree, requireRole } from '../sessions/runtime.js'
import { executorStatus } from '../tasks/scheduler.js'
import { findRepoRoot, initStore, readState, storeDirectory, updateState } from '../tasks/store.js'
import {
  approve,
  cancelTask,
  logEvent,
  renderBrief,
  renderTree,
  requireTask,
  sendBack,
  waitsFor,
} from '../tasks/task.js'
import { nonBlank, textResult } from '../tooling.js'

const COORDINATOR_TOOLS: string[] = [
  'task_declare',
  'task_revise',
  'task_list',
  'task_show',
  'task_cancel',
  'task_answer',
  'task_approve',
  'task_reject',
]
// The coordinator writes task specs; code reaches the repository only through tasks, not through pi-subagents' agents either
const WITHHELD_FROM_COORDINATOR = new Set(['edit', 'write', 'session_spawn', 'subagent', 'steer_subagent'])

function describeRun(state: State, task: Task): string {
  if (task.state === 'declared') {
    const waiting = waitsFor(state, task)

    return waiting.length === 0 ? '' : `waits for ${waiting.join(', ')}`
  }
  if (task.state === 'approving') {
    return task.approval === undefined ? 'waits for your sign-off' : 'merging'
  }
  const claim = task.claim
  if (claim === undefined) {
    return ''
  }
  const status = executorStatus(claim)

  return [
    claim.sessionId === undefined ? 'preparing its workspace' : `executor ${claim.sessionId} ${status}`,
    ...(status === 'asking' ? [`asks: ${claim.question}`] : []),
    ...(status === 'stalled' ? [`stalled: ${claim.stalled}`] : []),
  ].join(' · ')
}

export function renderBoard(state: State): string {
  return renderTree(state, task => describeRun(state, task))
}

/** Hands a root task whose executor waits for the coordinator to a fresh executor session, which finds `event` in its history */
export function unblock(task: Task, event: string): void {
  const { claim } = task
  if (claim === undefined || !['asking', 'stalled'].includes(executorStatus(claim))) {
    throw new Error(`${task.id} has no executor waiting for an answer; message a running one with session_send.`)
  }
  if (claim.sessionId === undefined) {
    throw new Error(`${task.id} stalled before its executor started; cancel it and declare it again.`)
  }
  claim.question = undefined
  claim.stalled = undefined
  claim.sessions = 0
  claim.handoff = true
  logEvent(task, event, Date.now())
}

function renderDetails(state: State, task: Task): string {
  const run = describeRun(state, task)

  return [
    renderBrief(state, task),
    '',
    `State: ${task.state}${run === '' ? '' : ` · ${run}`}${task.claim === undefined ? '' : ` · workspace ${task.claim.workspace.path}`}`,
    ...(task.note === undefined ? [] : [`Note: ${task.note}`]),
    ...task.reviews.map(
      review =>
        `Review by ${review.reviewer} on ${review.commit}: ${review.verdict}${review.findings === '' ? '' : ` · ${review.findings}`}`,
    ),
    'History:',
    ...task.log.map(entry => `- ${new Date(entry.at).toISOString()} ${entry.event}`),
  ].join('\n')
}

export function registerCoordinatorTools(pi: ExtensionAPI, host: Host): void {
  pi.registerTool(
    defineTool({
      name: 'task_list',
      label: 'Tasks',
      description: 'Show the task tree with each task state and whether its executor is running, asking or stalled.',
      parameters: Type.Object({}),
      defaultActive: false,
      execute: async () => textResult(renderBoard(readState(requireRole(host.runtime(), 'coordinator').store))),
    }),
  )

  pi.registerTool(
    defineTool({
      name: 'task_show',
      label: 'Show task',
      description: "Show a task's brief, state, reviews and history.",
      parameters: Type.Object({ id: nonBlank('Task id, such as T3 or T3.1') }),
      defaultActive: false,
      async execute(_toolCallId, params) {
        const runtime = host.runtime()
        if (runtime?.role === undefined) {
          throw new Error('Only governed sessions can use this tool.')
        }
        const state = readState(runtime.store)

        return textResult(renderDetails(state, requireTask(state, params.id)))
      },
    }),
  )

  pi.registerTool(
    defineTool({
      name: 'task_cancel',
      label: 'Cancel task',
      description:
        'Cancel an open task and its open subtasks. Its developer or reviewer stops at its next turn; the executor of a cancelled root task then exits and its workspace is removed.',
      parameters: Type.Object({ id: nonBlank('Task id'), reason: nonBlank('Why the task is no longer wanted') }),
      defaultActive: false,
      async execute(_toolCallId, params) {
        const runtime = requireRole(host.runtime(), 'coordinator')
        const cancelled = updateState(runtime.store, state =>
          cancelTask(state, params.id, runtime.sessionId, params.reason, Date.now()),
        )
        host.changed()

        return textResult(`Cancelled ${cancelled.map(task => task.id).join(', ')}.`)
      },
    }),
  )

  pi.registerTool(
    defineTool({
      name: 'task_answer',
      label: 'Answer executor',
      description:
        "Answer the question of a root task's executor, or unblock a stalled one with guidance; a fresh executor session continues the task with your answer.",
      parameters: Type.Object({ id: nonBlank('Root task id'), answer: nonBlank('Your answer or guidance') }),
      defaultActive: false,
      async execute(_toolCallId, params) {
        const runtime = requireRole(host.runtime(), 'coordinator')
        updateState(runtime.store, state => unblock(requireTask(state, params.id), `answered: ${params.answer}`))
        host.changed()

        return textResult(`A fresh executor session continues ${params.id} with your answer.`)
      },
    }),
  )

  pi.registerTool(
    defineTool({
      name: 'task_approve',
      label: 'Approve task',
      description:
        'Sign off a root task that passed its review, which merges it into its bookmark. You hear when it lands, or when it goes back to its executor because the merge conflicts or breaks a check.',
      parameters: Type.Object({
        id: nonBlank('Root task id'),
        commitMessage: nonBlank(
          "The task's commit message; read the user's commit message skill first if there is one",
        ),
      }),
      defaultActive: false,
      async execute(_toolCallId, params) {
        const runtime = requireRole(host.runtime(), 'coordinator')
        updateState(runtime.store, state =>
          approve(state, params.id, runtime.sessionId, params.commitMessage, Date.now()),
        )
        host.changed()

        return textResult(`${params.id} is approved and merges now.`)
      },
    }),
  )

  pi.registerTool(
    defineTool({
      name: 'task_reject',
      label: 'Send task back',
      description:
        'Refuse to sign off a root task that passed its review, and send it back with your findings to a fresh executor session.',
      parameters: Type.Object({
        id: nonBlank('Root task id'),
        findings: nonBlank('What is wrong, where, and what would make you sign it off'),
      }),
      defaultActive: false,
      async execute(_toolCallId, params) {
        const runtime = requireRole(host.runtime(), 'coordinator')
        updateState(runtime.store, state => sendBack(state, params.id, runtime.sessionId, params.findings, Date.now()))
        host.changed()

        return textResult(`${params.id} goes back to its executor with your findings.`)
      },
    }),
  )
}

/** Makes this TUI session the repository's coordinator, which also starts governing the repository */
export function coordinate(pi: ExtensionAPI, ctx: ExtensionCommandContext): Runtime {
  const repoRoot = findRepoRoot(ctx.cwd)
  if (repoRoot === undefined) {
    throw new Error('Run this in the main workspace of a jj repository.')
  }
  const { config, issues } = loadConfig(repoRoot, ctx.isProjectTrusted())
  if (issues.length > 0) {
    throw new Error(`Fix the config first:\n${issues.join('\n')}`)
  }
  const store = storeDirectory(repoRoot)
  const sessionId = ctx.sessionManager.getSessionId()
  initStore(store, config)
  updateState(store, state => {
    if (!leaseIsFree(state, sessionId)) {
      throw new Error(`Session ${state.lease?.sessionId} already coordinates this repository.`)
    }
    state.lease = { sessionId, pid: process.pid }
    state.config = config
  })
  activateCoordinatorTools(pi)

  return { store, repoRoot, sessionId, role: 'coordinator', environment: {} }
}

export function activateCoordinatorTools(pi: ExtensionAPI): void {
  pi.setActiveTools([...pi.getActiveTools().filter(name => !WITHHELD_FROM_COORDINATOR.has(name)), ...COORDINATOR_TOOLS])
}
