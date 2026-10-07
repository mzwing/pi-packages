import type { Runtime } from './runtime.js'
import type { Host } from './tooling.js'
import type { AgentBeforeSettleEventResult, ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { sendMail } from '@mzwing/pi-session-hub/api'
import { Type } from 'typebox'
import { nudgePrompt } from './prompts.js'
import { requireRole } from './runtime.js'
import { readState, updateState } from './store.js'
import { claimedRoot } from './task.js'
import { nonBlank, textResult } from './tooling.js'

const MAX_NUDGES = 3

/** Mail reaches the coordinator even while it is not running; it reads it when it resumes. */
export async function tellCoordinator(runtime: Runtime, rootId: string, body: string, wake: boolean): Promise<void> {
  const { lease } = readState(runtime.store)
  if (lease !== undefined) {
    await sendMail({ from: runtime.sessionId, fromName: `${rootId} executor`, to: lease.sessionId, body, wake })
  }
}

export function registerExecutor(pi: ExtensionAPI, host: Host): void {
  let nudges = 0

  pi.registerTool(
    defineTool({
      name: 'task_ask',
      label: 'Ask coordinator',
      description:
        'Ask the coordinator to decide something the brief leaves open. End your turn right after asking; your session is restarted with the answer.',
      parameters: Type.Object({ question: nonBlank('The decision you need, with the options you see') }),
      defaultActive: false,
      async execute(_toolCallId, params) {
        const runtime = requireRole(host.runtime(), 'executor')
        const rootId = updateState(runtime.store, state => {
          const root = claimedRoot(state, runtime.sessionId)!
          root.claim!.question = params.question
          root.claim!.answer = undefined

          return root.id
        })
        await tellCoordinator(
          runtime,
          rootId,
          `${rootId} asks: ${params.question}\n\nAnswer it with task_answer.`,
          true,
        )

        return textResult('The coordinator has your question. End your turn now; you are restarted with the answer.')
      },
    }),
  )

  // A run that ends with its task still open is sent back to work, a few times, before the task counts as stalled.
  pi.on('agent_before_settle', async (event): Promise<AgentBeforeSettleEventResult | undefined> => {
    const runtime = host.runtime()
    if (runtime?.role !== 'executor' || event.outcome !== 'completed') {
      return undefined
    }
    const state = readState(runtime.store)
    const root = claimedRoot(state, runtime.sessionId)
    if (root === undefined || root.claim!.question !== undefined) {
      return undefined
    }
    if (nudges === MAX_NUDGES) {
      const reason = `its executor tried to stop ${MAX_NUDGES + 1} times without finishing`
      updateState(runtime.store, current => {
        claimedRoot(current, runtime.sessionId)!.claim!.stalled = reason
      })
      await tellCoordinator(runtime, root.id, `${root.id} stalled: ${reason}. Unblock it with task_answer.`, true)

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

/** Tells the coordinator, whose scheduler wakes on executor mail, that this executor is gone. */
export async function announceExit(runtime: Runtime): Promise<void> {
  const root = Object.values(readState(runtime.store).tasks).find(
    task => task.parentId === undefined && task.claim?.sessionId === runtime.sessionId,
  )
  if (root !== undefined) {
    await tellCoordinator(runtime, root.id, `${root.id} executor exited; the task is ${root.state}.`, false)
  }
}
