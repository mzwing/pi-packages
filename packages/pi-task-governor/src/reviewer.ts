import type { ChildBinding } from './children.js'
import type { Runtime } from './runtime.js'
import type { Evidence } from './task.js'
import type { Host } from './tooling.js'
import type { AgentBeforeSettleEventResult, ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { StringEnum } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { runCheck } from './checks.js'
import { childBinding } from './children.js'
import { REVIEWER_NUDGE } from './prompts.js'
import { requireRole } from './runtime.js'
import { readState, updateState } from './store.js'
import { recordVerdict, requireTask } from './task.js'
import { nonBlank, textResult } from './tooling.js'
import { diff } from './vcs.js'

function review(host: Host): { runtime: Runtime; binding: ChildBinding } {
  const runtime = requireRole(host.runtime(), 'reviewer')

  return { runtime, binding: childBinding(runtime.sessionId)! }
}

export function registerReviewerTools(pi: ExtensionAPI, host: Host): void {
  let nudged = false

  pi.registerTool(
    defineTool({
      name: 'task_diff',
      label: 'Diff',
      description: 'Show the change under review, from where the task began to the commit being reviewed.',
      parameters: Type.Object({
        stat: Type.Optional(Type.Boolean({ description: 'Only the changed files and line counts (default false)' })),
      }),
      defaultActive: false,
      async execute(_toolCallId, params) {
        const { runtime, binding } = review(host)
        const task = requireTask(readState(runtime.store), binding.taskId)

        return textResult(await diff(runtime.repoRoot, task.base.commit!, binding.commit, params.stat ?? false))
      },
    }),
  )

  pi.registerTool(
    defineTool({
      name: 'task_check',
      label: 'Run check',
      description:
        "Run an acceptance criterion's check command in the task workspace and record the result as its evidence.",
      parameters: Type.Object({ criterion: nonBlank('Criterion id, such as A1 or G1') }),
      defaultActive: false,
      executionMode: 'sequential',
      async execute(_toolCallId, params) {
        const { runtime, binding } = review(host)
        const task = requireTask(readState(runtime.store), binding.taskId)
        const criterion = task.spec.acceptance.find(item => item.id === params.criterion)
        if (criterion?.check === undefined) {
          throw new Error(`${task.id} has no criterion ${params.criterion} with a check; judge it by observation.`)
        }
        const evidence = await runCheck(runtime, binding.workspace, criterion, binding.commit)
        binding.checks[criterion.id] = evidence

        return textResult(`${criterion.id} (\`${evidence.command}\`) exited ${evidence.exitCode}:\n${evidence.output}`)
      },
    }),
  )

  pi.registerTool(
    defineTool({
      name: 'task_verdict',
      label: 'Verdict',
      description:
        'Give the review verdict, once. A pass needs evidence for every criterion: a passing task_check run where the criterion has a check, otherwise an observation naming the files and lines you verified.',
      parameters: Type.Object({
        verdict: StringEnum(['pass', 'fail'] as const),
        observations: Type.Optional(
          Type.Array(
            Type.Object({
              criterion: nonBlank('Criterion id'),
              text: nonBlank('What you verified, citing files and lines'),
            }),
          ),
        ),
        findings: Type.Optional(nonBlank('For a failure, what is wrong and where; for a pass, anything worth noting')),
      }),
      defaultActive: false,
      async execute(_toolCallId, params) {
        const { runtime, binding } = review(host)
        if (params.verdict === 'fail' && params.findings === undefined) {
          throw new Error('A failed review needs findings the developer can act on.')
        }
        // A check run is the evidence for its criterion, whatever observation accompanies it.
        const evidence: Record<string, Evidence> = {
          ...Object.fromEntries(
            (params.observations ?? []).map(observation => [
              observation.criterion,
              { kind: 'observation' as const, text: observation.text },
            ]),
          ),
          ...binding.checks,
        }
        updateState(runtime.store, state =>
          recordVerdict(state, binding.taskId, {
            reviewer: runtime.sessionId,
            commit: binding.commit,
            verdict: params.verdict,
            evidence,
            findings: params.findings ?? '',
            at: Date.now(),
          }),
        )
        binding.verdict = params.verdict

        return textResult('Verdict recorded. End your run.')
      },
    }),
  )

  pi.on('agent_before_settle', (event): AgentBeforeSettleEventResult | undefined => {
    const runtime = host.runtime()
    if (runtime?.role !== 'reviewer' || event.outcome !== 'completed' || nudged) {
      return undefined
    }
    if (childBinding(runtime.sessionId)?.verdict !== undefined) {
      return undefined
    }
    nudged = true

    return {
      entries: [
        { type: 'custom_message', customType: 'pi-task-governor:nudge', content: REVIEWER_NUDGE, display: true },
      ],
      continue: true,
    }
  })
}
