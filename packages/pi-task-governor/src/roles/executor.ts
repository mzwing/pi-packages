import type { Runtime } from '../sessions/runtime.js'
import type { State, Task } from '../tasks/task.js'
import type { Host } from '../tooling.js'
import type { AgentBeforeSettleEventResult, ExtensionAPI, TurnEndEventResult } from '@earendil-works/pi-coding-agent'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { sendMail } from '@mzwing/pi-session-hub/api'
import { Type } from 'typebox'
import { WRAP_UP_TURNS } from '../sessions/children.js'
import { requireRole } from '../sessions/runtime.js'
import { readState, updateState } from '../tasks/store.js'
import { claimedRoot, focusOf, logEvent } from '../tasks/task.js'
import { nonBlank, textResult } from '../tooling.js'
import { handoffDuePrompt, nudgePrompt } from './prompts.js'

const MAX_NUDGES = 3
// A session that ran none of these has moved nothing on, so it has nothing to hand over.
const WORK_TOOLS = new Set(['task_develop', 'task_review', 'task_subtask'])
const NOTE = Type.String({
  pattern: '\\S',
  maxLength: 2_000,
  description: 'What is done, what remains, and the decisions taken with their reasons',
})

/** Mail reaches the coordinator even while it is not running; it reads it when it resumes. */
async function tellCoordinator(runtime: Runtime, rootId: string, body: string, wake: boolean): Promise<void> {
  const { lease } = readState(runtime.store)
  if (lease !== undefined) {
    await sendMail({ from: runtime.sessionId, fromName: `${rootId} executor`, to: lease.sessionId, body, wake })
  }
}

/**
 * The task this executor session still works on; undefined once its run is meant to end, after it asked the
 * coordinator, handed off, or passed its review, and when the task was cancelled.
 */
function workingRoot(state: State, sessionId: string): Task | undefined {
  const root = claimedRoot(state, sessionId)
  if (root === undefined || root.claim!.question !== undefined || root.claim!.handoff === true) {
    return undefined
  }

  return focusOf(state, root).state === 'claimed' ? root : undefined
}

/** Leaves the task to the coordinator: this run ends, and a fresh session continues with its answer. */
export async function askCoordinator(runtime: Runtime, question: string): Promise<void> {
  const rootId = updateState(runtime.store, state => {
    const root = claimedRoot(state, runtime.sessionId)!
    root.claim!.question = question
    logEvent(root, `asked: ${question}`, Date.now())

    return root.id
  })
  await tellCoordinator(
    runtime,
    rootId,
    `${rootId} asks: ${question}\n\nAnswer it with task_answer, or with task_revise where its brief is at fault.`,
    true,
  )
}

/** Has the scheduler start a fresh executor session once this one ends. */
function handOff(state: State, root: Task, sessionId: string, how: string, note?: string): void {
  if (note !== undefined) {
    focusOf(state, root).note = note
  }
  root.claim!.handoff = true
  logEvent(root, `executor session ${sessionId} handed off ${how}`, Date.now())
}

export function registerExecutor(pi: ExtensionAPI, host: Host): void {
  let nudges = 0
  let turns = 0
  let worked = false

  pi.registerTool(
    defineTool({
      name: 'task_note',
      label: 'Note',
      description:
        "Keep a note on your current task for whoever works it next: what is done, what remains, and the decisions taken with their reasons. It replaces the task's previous note, and stops being carried once the task is finished.",
      parameters: Type.Object({ note: NOTE }),
      defaultActive: false,
      async execute(_toolCallId, params) {
        const runtime = requireRole(host.runtime(), 'executor')
        const id = updateState(runtime.store, state => {
          const focus = focusOf(state, claimedRoot(state, runtime.sessionId)!)
          focus.note = params.note

          return focus.id
        })

        return textResult(`Noted on ${id}.`)
      },
    }),
  )

  pi.registerTool(
    defineTool({
      name: 'task_handoff',
      label: 'Hand off',
      description:
        "End this session and hand your task to a fresh executor session, which starts from the task board and the notes. Use it when this session has grown long or muddled. The note replaces your current task's note.",
      parameters: Type.Object({ note: NOTE }),
      defaultActive: false,
      async execute(_toolCallId, params) {
        const runtime = requireRole(host.runtime(), 'executor')
        if (!worked) {
          throw new Error(
            'Hand off only after working on the task in this session; a fresh session would start where you are.',
          )
        }
        updateState(runtime.store, state => {
          const root = workingRoot(state, runtime.sessionId)
          if (root === undefined) {
            throw new Error(
              'Nothing is left to hand off: the task waits for the coordinator, or is handed off already. End your run.',
            )
          }
          handOff(state, root, runtime.sessionId, 'by choice', params.note)
        })

        return textResult('Handed off. End your run now; a fresh session takes over from the task board and your note.')
      },
    }),
  )

  pi.registerTool(
    defineTool({
      name: 'task_ask',
      label: 'Ask coordinator',
      description:
        'Ask the coordinator to decide something the brief leaves open. End your turn right after asking; a fresh session continues with the answer.',
      parameters: Type.Object({ question: nonBlank('The decision you need, with the options you see') }),
      defaultActive: false,
      async execute(_toolCallId, params) {
        await askCoordinator(requireRole(host.runtime(), 'executor'), params.question)

        return textResult(
          'The coordinator has your question. End your turn now; a fresh session continues with the answer.',
        )
      },
    }),
  )

  pi.on('tool_execution_end', event => {
    if (WORK_TOOLS.has(event.toolName) && !event.isError) {
      worked = true
    }
  })

  pi.on('turn_end', (_event, ctx): TurnEndEventResult | undefined => {
    const runtime = host.runtime()
    if (runtime?.role !== 'executor') {
      return undefined
    }
    turns += 1
    const state = readState(runtime.store)
    const { maxTurns } = state.config.roles.executor
    if (turns === maxTurns - WRAP_UP_TURNS && workingRoot(state, runtime.sessionId) !== undefined) {
      return {
        entries: [
          {
            type: 'custom_message',
            customType: 'pi-task-governor:nudge',
            content: handoffDuePrompt(WRAP_UP_TURNS),
            display: true,
          },
        ],
      }
    }
    // Once: the turn that ends an aborted run comes after it.
    if (turns === maxTurns) {
      // One that did no work ends like a session that gave up.
      if (worked) {
        updateState(runtime.store, current => {
          const root = workingRoot(current, runtime.sessionId)
          if (root !== undefined) {
            handOff(current, root, runtime.sessionId, `after ${turns} turns`)
          }
        })
      }
      ctx.abort()
    }

    return undefined
  })

  // A run that ends with its task still open is sent back to work a few times; then it ends, and the scheduler
  // replaces the session.
  pi.on('agent_before_settle', (event): AgentBeforeSettleEventResult | undefined => {
    const runtime = host.runtime()
    if (runtime?.role !== 'executor' || event.outcome !== 'completed' || nudges === MAX_NUDGES) {
      return undefined
    }
    const state = readState(runtime.store)
    const root = workingRoot(state, runtime.sessionId)
    if (root === undefined) {
      return undefined
    }
    nudges += 1

    return {
      entries: [
        {
          type: 'custom_message',
          customType: 'pi-task-governor:nudge',
          content: nudgePrompt(state, root),
          display: true,
        },
      ],
      continue: true,
    }
  })
}

/**
 * Tells the coordinator, whose scheduler wakes on executor mail, that this executor is gone. The mail arrives before
 * the process ends, so the claim is cleared first for the scheduler to find it gone.
 */
export async function announceExit(runtime: Runtime): Promise<void> {
  const root = updateState(runtime.store, state => {
    const task = Object.values(state.tasks).find(
      current => current.parentId === undefined && current.claim?.sessionId === runtime.sessionId,
    )
    if (task !== undefined) {
      task.claim!.pid = undefined
    }

    return task
  })
  if (root !== undefined) {
    await tellCoordinator(runtime, root.id, `${root.id} executor exited; the task is ${root.state}.`, false)
  }
}
