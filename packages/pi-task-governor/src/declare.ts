import type { Host } from './tooling.js'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { requireRole } from './runtime.js'
import { readState, updateState } from './store.js'
import { claimedRoot, declareChild, declareRoot, focusOf, renderBrief } from './task.js'
import { nonBlank, textResult } from './tooling.js'
import { bookmarkCommit, commitWorkingCopy, headOf } from './vcs.js'

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
        'Declare a root task. It queues until an executor slot is free; an independent executor session then claims it, works it in its own jj workspace and merges it into the bookmark once a reviewer signs it off. Scope, boundary and non-goals fence the work in; every acceptance criterion needs evidence before sign-off, so prefer criteria with a check command.',
      parameters: Type.Object({
        ...SPEC_PARAMETERS,
        bookmark: Type.Optional(
          nonBlank('Bookmark the task branches from and merges back into (default from the config, usually main)'),
        ),
      }),
      defaultActive: false,
      async execute(_toolCallId, params) {
        const runtime = requireRole(host.runtime(), 'coordinator')
        const bookmark = params.bookmark ?? readState(runtime.store).config.defaultBookmark
        // Fails on a bookmark the repository does not have, before anything is declared against it.
        await bookmarkCommit(runtime.repoRoot, bookmark)
        const brief = updateState(runtime.store, state =>
          renderBrief(state, declareRoot(state, params, bookmark, runtime.sessionId, Date.now())),
        )
        host.changed()

        return textResult(`Declared:\n\n${brief}`)
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
        // The subtask's review covers only what changes after this point.
        await commitWorkingCopy(workspace, `${focus.id}: ${focus.title}`)
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
