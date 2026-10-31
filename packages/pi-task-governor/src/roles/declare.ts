import type { Host } from '../tooling.js'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { requireRole } from '../sessions/runtime.js'
import { readState, updateState } from '../tasks/store.js'
import {
  claimedRoot,
  declareChild,
  declareRoot,
  focusOf,
  isOpen,
  logEvent,
  renderBrief,
  requireTask,
  reviseBrief,
  rootOf,
  sendBack,
} from '../tasks/task.js'
import { nonBlank, textResult } from '../tooling.js'
import { bookmarkCommit, headOf, saveWorkingCopy } from '../workspace/vcs.js'
import { unblock } from './coordinator.js'

const SPEC_PARAMETERS = {
  title: nonBlank('Short imperative title'),
  problem: nonBlank('What is wrong or missing, and why it matters'),
  scope: nonBlank('What the task changes: the content of the work'),
  boundary: nonBlank('Which files, modules and behaviours the work may reach, and nothing beyond them'),
  nonGoals: Type.Array(nonBlank('Something the task must not do'), { minItems: 1 }),
  acceptance: Type.Array(
    Type.Object({
      statement: nonBlank('A condition that holds once the task is done'),
      check: Type.Optional(
        nonBlank('Shell command, run in the task workspace, that exits 0 exactly when the condition holds'),
      ),
    }),
    { minItems: 1 },
  ),
}

export function registerDeclareTools(pi: ExtensionAPI, host: Host): void {
  pi.registerTool(
    defineTool({
      name: 'task_declare',
      label: 'Declare task',
      description:
        'Declare a root task. It queues until an executor slot is free, and until the tasks in `after` are merged; an independent executor session then claims it and works it in its own jj workspace. Once a reviewer signs it off with evidence, you sign it off too, and it merges into the bookmark. Scope, boundary and non-goals fence the work in; every acceptance criterion needs evidence before sign-off, so prefer criteria with a check command.',
      parameters: Type.Object({
        ...SPEC_PARAMETERS,
        bookmark: Type.Optional(
          nonBlank('Bookmark the task branches from and merges back into (default from the config, usually main)'),
        ),
        after: Type.Optional(
          Type.Array(nonBlank('Id of a root task this one needs merged first, such as T3'), {
            description: 'Root tasks of the same bookmark that must be merged before this one starts',
          }),
        ),
      }),
      defaultActive: false,
      async execute(_toolCallId, params) {
        const runtime = requireRole(host.runtime(), 'coordinator')
        const bookmark = params.bookmark ?? readState(runtime.store).config.defaultBookmark
        // Fails on a bookmark the repository does not have, before anything is declared against it
        await bookmarkCommit(runtime.repoRoot, bookmark)
        const brief = updateState(runtime.store, state =>
          renderBrief(state, declareRoot(state, params, bookmark, params.after ?? [], runtime.sessionId, Date.now())),
        )
        host.changed()

        return textResult(`Declared:\n\n${brief}`)
      },
    }),
  )

  pi.registerTool(
    defineTool({
      name: 'task_revise',
      label: 'Revise task',
      description:
        'Revise the brief of a task no executor is working on: a root task that waits to start or for your sign-off, or a task whose executor waits for your answer or stalled. Give only the parts that change; new acceptance criteria replace the old ones. A task its executor left waiting goes on in a fresh executor session, and one that waited for your sign-off goes back to be reviewed against the new brief.',
      parameters: Type.Object({
        id: nonBlank('Task id, such as T3 or T3.1'),
        reason: nonBlank('Why the brief changes, for whoever works the task next'),
        ...Type.Partial(Type.Object(SPEC_PARAMETERS)).properties,
      }),
      defaultActive: false,
      async execute(_toolCallId, params) {
        const runtime = requireRole(host.runtime(), 'coordinator')
        const { id, reason, ...changes } = params
        const result = updateState(runtime.store, state => {
          const task = requireTask(state, id)
          if (!isOpen(task)) {
            throw new Error(`${id} is already ${task.state}.`)
          }
          const root = rootOf(state, task)
          reviseBrief(state, task, changes)
          const brief = renderBrief(state, task)
          const event = `brief of ${id} revised by ${runtime.sessionId}: ${reason}`
          if (root.state === 'declared') {
            logEvent(root, event, Date.now())

            return `${brief}\n\nIt starts on this brief once its turn comes.`
          }
          if (root.state === 'approving') {
            sendBack(state, root.id, runtime.sessionId, `its brief was revised: ${reason}`, Date.now())

            return `${brief}\n\nIt goes back to its executor to be reviewed against this brief.`
          }
          unblock(root, event)

          return `${brief}\n\nA fresh executor session continues ${root.id} on this brief.`
        })
        host.changed()

        return textResult(`Revised:\n\n${result}`)
      },
    }),
  )

  pi.registerTool(
    defineTool({
      name: 'task_subtask',
      label: 'Open subtask',
      description:
        'Open a subtask of your current task for a separate problem that must be solved first, and dive into it: it shares the workspace, and its parent waits until it is signed off. Fence it in as tightly as a root task.',
      parameters: Type.Object(SPEC_PARAMETERS),
      defaultActive: false,
      executionMode: 'sequential',
      async execute(_toolCallId, params) {
        const runtime = requireRole(host.runtime(), 'executor')
        const state = readState(runtime.store)
        const root = claimedRoot(state, runtime.sessionId)!
        const focus = focusOf(state, root)
        const workspace = root.claim!.workspace
        // The subtask's review covers only what changes after this point
        await saveWorkingCopy(runtime.repoRoot, workspace, root.base.commit!)
        const head = await headOf(runtime.repoRoot, workspace)
        const brief = updateState(runtime.store, current =>
          renderBrief(current, declareChild(current, focus.id, params, runtime.sessionId, head, Date.now())),
        )

        return textResult(
          `Opened and dived into:\n\n${brief}\n\nWork it with task_develop and task_review; its parent waits until it is signed off.`,
        )
      },
    }),
  )
}
