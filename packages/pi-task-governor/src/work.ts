import type { ChildBinding } from './children.js'
import type { Runtime } from './runtime.js'
import type { State, Task } from './task.js'
import type { Host } from './tooling.js'
import type { Workspace } from './vcs.js'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { failedChecks } from './checks.js'
import { runChild } from './children.js'
import { tellCoordinator } from './executor.js'
import { developerPrompt, returnToParentPrompt, reviewerPrompt } from './prompts.js'
import { requireRole } from './runtime.js'
import { readState, updateState } from './store.js'
import { beginReview, claimedRoot, completeMerge, focusOf, reopen, requireTask } from './task.js'
import { nonBlank, textResult } from './tooling.js'
import { commitWorkingCopy, diff, headOf, mergeInto } from './vcs.js'

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
  const focus = focusOf(state, root)
  if (focus.state !== 'claimed') {
    throw new Error(`${focus.id} is ${focus.state}, not open for work.`)
  }

  return { runtime, state, root, focus, workspace: root.claim!.workspace }
}

/** Merges a signed-off root task into its bookmark and says what the executor should do next. */
async function merge(runtime: Runtime, root: Task, workspace: Workspace): Promise<string> {
  const bookmark = root.base.bookmark!
  const result = await mergeInto(runtime.repoRoot, workspace, bookmark, `${root.id}: merge ${bookmark}`, async () =>
    failedChecks(runtime, workspace, root.spec.acceptance, await headOf(runtime.repoRoot, workspace)),
  )
  const now = Date.now()
  switch (result.kind) {
    case 'merged':
      updateState(runtime.store, state => completeMerge(state, root.id, result.commit, now))
      await tellCoordinator(runtime, root.id, `${root.id} is merged into ${bookmark}.`, false)

      return `${root.id} is merged into ${bookmark} and done. End your run.`
    case 'conflicted':
      updateState(runtime.store, state =>
        reopen(state, root.id, `merging into ${bookmark} conflicted`, now, result.onto),
      )

      return `Merging ${root.id} into ${bookmark} conflicted: other work landed there first. The workspace now holds a merge commit with conflict markers; have the developer resolve them, then review again.`
    case 'failed-checks':
      updateState(runtime.store, state =>
        reopen(state, root.id, `checks failed after rebasing onto ${bookmark}`, now, result.onto),
      )

      return `${root.id} rebased cleanly onto ${bookmark}, but its checks then failed:\n${result.detail}\nHave the developer fix this, then review again.`
  }
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
        const { runtime, state, focus, workspace } = currentWork(host)
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
        const report = await runChild(
          ctx,
          { binding, model, thinking, maxTurns, prompt: developerPrompt(state, focus, params.instructions) },
          signal,
        )
        lastReport = report
        const changed = await commitWorkingCopy(workspace, `${focus.id}: ${focus.title}\n\n${report}`)
        const stat = await diff(runtime.repoRoot, focus.base.commit!, await headOf(runtime.repoRoot, workspace), true)

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
      description:
        'Have a fresh reviewer session judge your current task against every acceptance criterion. A pass finishes a subtask, or merges a root task into its bookmark; a failure returns findings to fix.',
      parameters: Type.Object({}),
      defaultActive: false,
      executionMode: 'sequential',
      async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
        const { runtime, state, root, focus, workspace } = currentWork(host)
        await commitWorkingCopy(workspace, `${focus.id}: ${focus.title}`)
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
          if (binding.verdict === undefined) {
            return textResult(`The reviewer of ${focus.id} ended without a verdict; run task_review again.`)
          }
          const reviewed = readState(runtime.store)
          if (binding.verdict === 'fail') {
            return textResult(
              `${focus.id} failed its review:\n\n${requireTask(reviewed, focus.id).reviews.at(-1)!.findings}\n\nSend the developer back with these findings, then review again.`,
            )
          }

          return textResult(
            focus.parentId === undefined
              ? await merge(runtime, root, workspace)
              : returnToParentPrompt(reviewed, focus),
          )
        } finally {
          // Whatever cut the review short, such as a missing verdict or an error, its task must not stay in review.
          updateState(runtime.store, current => reopen(current, focus.id, 'its review ended unfinished', Date.now()))
        }
      },
    }),
  )
}
