import type { ChildBinding } from '../sessions/children.js'
import type { Runtime } from '../sessions/runtime.js'
import type { State, Task } from '../tasks/task.js'
import type { Host } from '../tooling.js'
import type { Workspace } from '../workspace/vcs.js'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { runChild } from '../sessions/children.js'
import { requireRole } from '../sessions/runtime.js'
import { readState, updateState } from '../tasks/store.js'
import { beginReview, claimedRoot, failedReviewsInARow, focusOf, logEvent, reopen, requireTask } from '../tasks/task.js'
import { nonBlank, textResult } from '../tooling.js'
import { diff, headOf, saveWorkingCopy } from '../workspace/vcs.js'
import { askCoordinator } from './executor.js'
import { developerPrompt, returnToParentPrompt, reviewerPrompt } from './prompts.js'

// Each time a task fails this many reviews in a row, its executor stops to ask the coordinator how to go on.
const FAILED_REVIEWS_BEFORE_ASKING = 3

interface Work {
  runtime: Runtime
  state: State
  root: Task
  /** The deepest open task, where depth-first work happens. */
  focus: Task
  workspace: Workspace
}

function currentWork(host: Host): Work {
  const runtime = requireRole(host.runtime(), 'executor')
  const state = readState(runtime.store)
  const root = claimedRoot(state, runtime.sessionId)!
  if (root.claim!.question !== undefined) {
    throw new Error(`${root.id} waits for the coordinator's answer; end your run.`)
  }
  const focus = focusOf(state, root)
  if (focus.state !== 'claimed') {
    throw new Error(`${focus.id} is ${focus.state}, not open for work.`)
  }

  return { runtime, state, root, focus, workspace: root.claim!.workspace }
}

export function registerWorkTools(pi: ExtensionAPI, host: Host): void {
  // The developer's last report, which the reviewer receives as a claim to verify.
  let lastReport: string | undefined

  pi.registerTool(
    defineTool({
      name: 'task_develop',
      label: 'Develop',
      description:
        'Have a developer session implement your current task in its workspace, following the brief and your instructions. The controller commits what it changes; the result is its report and the diffstat of the task so far.',
      parameters: Type.Object({
        instructions: nonBlank(
          'What the developer should do in this run: an approach, a part of the work, or the findings of a failed review to fix',
        ),
      }),
      defaultActive: false,
      executionMode: 'sequential',
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const { runtime, state, root, focus, workspace } = currentWork(host)
        const { model, thinking, maxTurns } = state.config.roles.developer
        const binding: ChildBinding = {
          role: 'developer',
          store: runtime.store,
          taskId: focus.id,
          workspace,
          environment: runtime.environment,
          commit: focus.base.commit!,
          checks: {},
        }
        const before = await headOf(runtime.repoRoot, workspace)
        const report = await runChild(
          ctx,
          { binding, model, thinking, maxTurns, prompt: developerPrompt(state, focus, params.instructions) },
          signal,
        )
        lastReport = report
        const changed = await saveWorkingCopy(runtime.repoRoot, workspace, root.base.commit!)
        const head = await headOf(runtime.repoRoot, workspace)
        const run = changed ? (await diff(runtime.repoRoot, before, head, true)).trim().split('\n').at(-1) : undefined
        updateState(runtime.store, current =>
          logEvent(
            requireTask(current, focus.id),
            run === undefined ? 'developer run changed nothing' : `developer run: ${run}`,
            Date.now(),
          ),
        )
        const stat = await diff(runtime.repoRoot, focus.base.commit!, head, true)

        return textResult(
          [
            `The developer of ${focus.id} reports:`,
            report,
            changed ? `Changes since ${focus.id} began:\n${stat}` : 'It changed nothing in this run.',
          ].join('\n\n'),
        )
      },
    }),
  )

  pi.registerTool(
    defineTool({
      name: 'task_review',
      label: 'Review',
      description: `Have a fresh reviewer session judge your current task against every acceptance criterion. A pass finishes a subtask, or hands a root task to the coordinator's sign-off before it merges; a failure returns findings to fix, and every ${FAILED_REVIEWS_BEFORE_ASKING} failures in a row ask the coordinator how the task should go on.`,
      parameters: Type.Object({}),
      defaultActive: false,
      executionMode: 'sequential',
      async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
        const { runtime, state, root, focus, workspace } = currentWork(host)
        await saveWorkingCopy(runtime.repoRoot, workspace, root.base.commit!)
        const head = await headOf(runtime.repoRoot, workspace)
        if (head === focus.base.commit) {
          throw new Error(`${focus.id} has no changes to review yet.`)
        }
        updateState(runtime.store, current => beginReview(current, focus.id, runtime.sessionId, head, Date.now()))
        const binding: ChildBinding = {
          role: 'reviewer',
          store: runtime.store,
          taskId: focus.id,
          workspace,
          environment: runtime.environment,
          commit: head,
          checks: {},
        }
        const { model, thinking, maxTurns } = state.config.roles.reviewer
        try {
          await runChild(
            ctx,
            { binding, model, thinking, maxTurns, prompt: reviewerPrompt(state, focus, head, lastReport) },
            signal,
          )
        } finally {
          // Whatever cut the review short, such as an error or an abort, its task must not stay in review.
          if (binding.verdict === undefined) {
            updateState(runtime.store, current => reopen(current, focus.id, 'its review ended unfinished', Date.now()))
          }
        }
        if (binding.verdict === undefined) {
          return textResult(`The reviewer of ${focus.id} ended without a verdict; run task_review again.`)
        }
        const reviewed = readState(runtime.store)
        if (binding.verdict === 'fail') {
          const task = requireTask(reviewed, focus.id)
          const failures = failedReviewsInARow(task)
          if (failures % FAILED_REVIEWS_BEFORE_ASKING === 0) {
            await askCoordinator(
              runtime,
              `${focus.id} failed its review ${failures} times in a row; how should it go on? task_show ${focus.id} has its reviews.`,
            )

            return textResult(
              `${focus.id} failed its review ${failures} times in a row, so the coordinator was asked how it should go on. End your run now; a fresh session continues with the answer.`,
            )
          }

          return textResult(
            `${focus.id} failed its review:\n\n${task.reviews.at(-1)!.findings}\n\nSend the developer back with these findings, then review again.`,
          )
        }

        return textResult(
          focus.parentId === undefined
            ? `${focus.id} passed its review and waits for the coordinator's sign-off before it merges. End your run now; if it comes back, a fresh session continues with the reason.`
            : returnToParentPrompt(reviewed, focus),
        )
      },
    }),
  )
}
