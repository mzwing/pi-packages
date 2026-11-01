import type { AutoReviewConfig } from '../config/config.js'
import type { ContextFile, Preset, ReviewFields, ReviewOutcome } from '../presets/presets.js'
import type { ReviewConversation } from './conversation.js'
import type { CallFailure, CallUsage } from './model-call.js'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { Authorizer, AuthorizerVerdict, PromptPermissionDetails } from '@gotgenes/pi-permission-system'
import { PRESETS } from '../presets/presets.js'
import { createModelCall } from './model-call.js'
import { resolveReviewModel } from './model.js'

const DECISION_EVENT = 'auto_review.decision'

type FailureCategory = 'provider-unresolved' | 'model-unresolved' | CallFailure

export interface ReviewerRuntime {
  config: AutoReviewConfig
  /** Read at every review, since `signal` belongs to the turn in progress */
  context: Pick<ExtensionContext, 'modelRegistry' | 'sessionManager' | 'signal'>
  /** The context files the user's trust covers, as of the latest run */
  contextFiles: () => readonly ContextFile[]
  /** Aborted when the reviewer is replaced or the session ends */
  sessionSignal: AbortSignal
}

export interface PermissionReviewer {
  authorize: Authorizer['authorize']
  /** Clears the denials the preset counts per turn */
  resetTurn: () => void
}

type ReviewResult =
  | (Exclude<ReviewOutcome, { kind: 'failed' }> & { usage: CallUsage })
  | { kind: 'failed'; failure: FailureCategory; fields?: ReviewFields; usage?: CallUsage }

async function runReview(
  runtime: ReviewerRuntime,
  preset: Preset,
  details: PromptPermissionDetails,
  conversation: ReviewConversation | undefined,
): Promise<ReviewResult> {
  const { config, context } = runtime
  const deadline = Date.now() + config.timeoutMs
  const timeoutController = new AbortController()
  const timeout = setTimeout(() => timeoutController.abort(), config.timeoutMs)
  const turnSignal = context.signal
  const signal = AbortSignal.any([
    timeoutController.signal,
    runtime.sessionSignal,
    ...(turnSignal === undefined ? [] : [turnSignal]),
  ])

  try {
    if (signal.aborted) {
      return { kind: 'failed', failure: 'cancelled' }
    }
    const resolved = resolveReviewModel(context.modelRegistry, config)
    if (!resolved.ok) {
      return { kind: 'failed', failure: resolved.category }
    }
    const model = resolved.value
    const usage = { input: 0, cacheRead: 0, output: 0 }
    const complete = createModelCall({
      registry: context.modelRegistry,
      model,
      config,
      sessionId: context.sessionManager.getSessionId(),
      signal,
      timeoutSignal: timeoutController.signal,
      deadline,
      usage,
    })
    const outcome = await preset.review(
      {
        config,
        branch: context.sessionManager.getBranch(),
        details,
        contextFiles: runtime.contextFiles(),
        conversation,
        contextWindow: model.contextWindow,
      },
      complete,
    )

    return { ...outcome, usage }
  } finally {
    clearTimeout(timeout)
  }
}

export function createPermissionReviewer(runtime: ReviewerRuntime): PermissionReviewer {
  const { config } = runtime
  const preset = PRESETS[config.preset]
  // Per reviewer, so a retired one finishing a review late cannot trip its successor
  const limiter = preset.createLimiter()
  // As upstream keeps it: concurrent reviews each continue the conversation they started from, and the last to finish wins
  let conversation: ReviewConversation | undefined

  const authorize: Authorizer['authorize'] = async (details, _query, log) => {
    const startedAt = Date.now()
    const entryBase = { requestId: details.requestId, provider: config.provider, model: config.model }
    const elapsed = (): number => Math.max(0, Date.now() - startedAt)
    const logFailure = (entry: Record<string, unknown>): void => {
      log.review(DECISION_EVENT, entry)
      log.debug('auto_review.failure', entry)
    }

    try {
      const refusal = limiter.refusal()
      if (refusal !== undefined) {
        log.review('auto_review.circuit_open', {
          ...entryBase,
          outcome: 'deny',
          durationMs: 0,
          errorCategory: 'circuit-open',
        })

        return { kind: 'deny', reason: refusal }
      }

      const result = await runReview(runtime, preset, details, conversation)
      const durationMs = elapsed()
      const diagnostics = {
        policyRevision: preset.policyRevision,
        contextSource: 'active-branch',
        ...result.fields,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      }
      if (result.kind === 'failed') {
        // The conversation may be what failed, such as one too long for the provider; an interruption says nothing of it
        if (result.failure !== 'cancelled') {
          conversation = undefined
        }
        // Deferring would open the human prompt the user just escaped, and Pi drops an interrupted call's verdict anyway
        const verdict: AuthorizerVerdict =
          result.failure === 'cancelled'
            ? { kind: 'deny', reason: 'The automatic review was cancelled before it finished' }
            : { kind: 'defer' }
        limiter.recordNonDenial()
        logFailure({ ...entryBase, outcome: verdict.kind, errorCategory: result.failure, durationMs, ...diagnostics })

        return verdict
      }

      conversation = result.conversation
      if (result.kind === 'allow') {
        limiter.recordNonDenial()
        log.review(DECISION_EVENT, { ...entryBase, outcome: 'allow', durationMs, ...diagnostics })

        return { kind: 'allow' }
      }
      const denialLimit = limiter.recordDenial()
      if (denialLimit !== undefined) {
        log.review(DECISION_EVENT, { ...entryBase, outcome: 'defer', denialLimit, durationMs, ...diagnostics })

        return { kind: 'defer' }
      }
      log.review(DECISION_EVENT, { ...entryBase, outcome: 'deny', durationMs, ...diagnostics })

      return { kind: 'deny', reason: result.reason }
    } catch {
      // The chain does not isolate a link that throws, so every internal failure has to leave as a verdict
      conversation = undefined
      limiter.recordNonDenial()
      logFailure({ ...entryBase, outcome: 'defer', errorCategory: 'internal-error', durationMs: elapsed() })

      return { kind: 'defer' }
    }
  }

  return { authorize, resetTurn: () => limiter.resetTurn() }
}
