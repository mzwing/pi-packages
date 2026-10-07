import type { Runtime } from './runtime.js'
import type { State, Task } from './task.js'
import type { Host } from './tooling.js'
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import process from 'node:process'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { loadConfig } from './config.js'
import { leaseIsFree, requireRole } from './runtime.js'
import { executorStatus } from './scheduler.js'
import { findRepoRoot, initStore, readState, storeDirectory, updateState } from './store.js'
import { cancelTask, renderBrief, renderTree, requireTask } from './task.js'
import { nonBlank, textResult } from './tooling.js'

const COORDINATOR_TOOLS: string[] = ['task_declare', 'task_list', 'task_show', 'task_cancel', 'task_answer']
// The coordinator writes task specs; code reaches the repository only through tasks, not through pi-subagents' agents either.
const WITHHELD_FROM_COORDINATOR = new Set(['edit', 'write', 'session_spawn', 'subagent', 'steer_subagent'])

function describeRun(task: Task): string {
  const claim = task.claim
  if (claim === undefined) {
    return ''
  }
  const status = executorStatus(claim)

  return [
    `executor ${claim.sessionId} ${status}`,
    ...(status === 'asking' ? [`asks: ${claim.question}`] : []),
    ...(status === 'stalled' ? [`stalled: ${claim.stalled}`] : []),
  ].join(' · ')
}

export function renderBoard(state: State): string {
  return renderTree(state, describeRun)
}

function renderDetails(state: State, task: Task): string {
  return [
    renderBrief(state, task),
    '',
    `State: ${task.state}${task.claim === undefined ? '' : ` · ${describeRun(task)} · workspace ${task.claim.workspace.path}`}`,
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
        "Answer the question of a root task's executor, or unblock a stalled one with guidance; its executor restarts with your answer.",
      parameters: Type.Object({ id: nonBlank('Root task id'), answer: nonBlank('Your answer or guidance') }),
      defaultActive: false,
      async execute(_toolCallId, params) {
        const runtime = requireRole(host.runtime(), 'coordinator')
        updateState(runtime.store, state => {
          const { claim } = requireTask(state, params.id)
          if (claim === undefined || !['asking', 'stalled'].includes(executorStatus(claim))) {
            throw new Error(
              `${params.id} has no executor waiting for an answer; message a running one with session_send.`,
            )
          }
          if (claim.pid === undefined) {
            throw new Error(`${params.id} stalled before its executor started; cancel it and declare it again.`)
          }
          claim.answer = params.answer
          claim.stalled = undefined
          claim.restarts = 0
        })
        host.changed()

        return textResult(`${params.id} restarts with your answer.`)
      },
    }),
  )
}

/** Makes this TUI session the repository's coordinator, which also starts governing the repository. */
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
