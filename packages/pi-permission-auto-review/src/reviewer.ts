import type { DenialCircuitBreaker } from './circuit-breaker.js'
import type { AutoReviewConfig } from './config.js'
import type { TranscriptStats } from './transcript.js'
import type { ReviewAssessment } from './verdict.js'
import type { ExtensionContext, ModelRegistry } from '@earendil-works/pi-coding-agent'
import type { Authorizer, AuthorizerLog, PromptPermissionDetails } from '@gotgenes/pi-permission-system'
import { resolveReviewModel } from './model.js'
import { POLICY_REVISION } from './policy.js'
import { buildReviewPrompt } from './prompt.js'
import { renderTranscript } from './transcript.js'
import { parseReviewAssessment } from './verdict.js'

const RETRY_DELAYS_MS = [250, 1_000]
const MAX_OUTPUT_TOKENS = 1_000
const DECISION_EVENT = 'auto_review.decision'

type FailureCategory =
  | 'provider-unresolved'
  | 'model-unresolved'
  | 'provider-error'
  | 'invalid-response'
  | 'timeout'
  | 'cancelled'
  | 'internal-error'

export interface ReviewerRuntime {
  config: AutoReviewConfig
  registry: ModelRegistry
  sessionManager: ExtensionContext['sessionManager']
  circuitBreaker: DenialCircuitBreaker
  /** Aborted when the reviewer is replaced or the session ends. */
  sessionSignal: AbortSignal
}

interface ContextDiagnostics extends TranscriptStats {
  policyRevision: string
  contextSource: 'active-branch'
}

type ReviewResult =
  | { assessment: ReviewAssessment; contextDiagnostics: ContextDiagnostics }
  | { failure: FailureCategory; contextDiagnostics?: ContextDiagnostics }

function abortError(): Error {
  const error = new Error('operation aborted')
  error.name = 'AbortError'

  return error
}

/** Resolves early on abort; the caller checks the signal. */
async function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/** A provider is not bound to honour the abort signal promptly, so the timeout is enforced here. */
async function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw abortError()
  }

  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

async function runReview(runtime: ReviewerRuntime, details: PromptPermissionDetails): Promise<ReviewResult> {
  const { config, registry } = runtime
  const startedAt = Date.now()
  const timeoutController = new AbortController()
  const timeout = setTimeout(() => timeoutController.abort(), config.timeoutMs)
  const signal = AbortSignal.any([timeoutController.signal, runtime.sessionSignal])

  try {
    const transcript = renderTranscript(runtime.sessionManager.getBranch())
    const contextDiagnostics: ContextDiagnostics = {
      policyRevision: POLICY_REVISION,
      contextSource: 'active-branch',
      ...transcript.stats,
    }
    const failure = (category: FailureCategory): ReviewResult => ({ failure: category, contextDiagnostics })
    const aborted = (): ReviewResult => failure(timeoutController.signal.aborted ? 'timeout' : 'cancelled')

    const resolved = resolveReviewModel(registry, config)
    if (!resolved.ok) {
      return failure(resolved.category)
    }
    const model = resolved.value
    const prompt = buildReviewPrompt(config, transcript, details)

    let text: string
    for (let attempt = 0; ; attempt += 1) {
      try {
        // The registry resolves the provider's authentication per request, so an unusable login lands here.
        const stream = registry.streamSimple(
          model,
          {
            systemPrompt: prompt.systemPrompt,
            messages: [{ role: 'user', content: prompt.userPrompt, timestamp: Date.now() }],
          },
          {
            maxRetries: 0,
            maxTokens: MAX_OUTPUT_TOKENS,
            signal,
            timeoutMs: Math.max(1, config.timeoutMs - (Date.now() - startedAt)),
            // Gateways such as opencode-go reject requests without a session id.
            sessionId: runtime.sessionManager.getSessionId(),
            ...(model.reasoning && config.reasoning !== 'off' ? { reasoning: config.reasoning } : {}),
          },
        )
        const message = await raceWithSignal(stream.result(), signal)
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          throw new Error(message.errorMessage ?? message.stopReason)
        }
        text = message.content
          .flatMap(block => (block.type === 'text' ? block.text : []))
          .join('')
          .trim()
        break
      } catch {
        const delay = RETRY_DELAYS_MS[attempt]
        if (signal.aborted) {
          return aborted()
        }
        if (delay === undefined) {
          return failure('provider-error')
        }
        await sleep(delay, signal)
        if (signal.aborted) {
          return aborted()
        }
      }
    }

    try {
      return { assessment: parseReviewAssessment(text), contextDiagnostics }
    } catch {
      return failure('invalid-response')
    }
  } finally {
    clearTimeout(timeout)
  }
}

function logFailure(
  log: AuthorizerLog,
  config: AutoReviewConfig,
  details: PromptPermissionDetails,
  result: { failure: FailureCategory; contextDiagnostics?: ContextDiagnostics },
  durationMs: number,
): void {
  const entry = {
    requestId: details.requestId,
    provider: config.provider,
    model: config.model,
    outcome: 'defer',
    errorCategory: result.failure,
    durationMs,
    ...result.contextDiagnostics,
  }
  log.review(DECISION_EVENT, entry)
  log.debug('auto_review.failure', entry)
}

export function createPermissionReviewer(runtime: ReviewerRuntime): Authorizer['authorize'] {
  const { config, circuitBreaker } = runtime

  return async (details, _query, log) => {
    const startedAt = Date.now()
    try {
      if (circuitBreaker.isOpen()) {
        log.review('auto_review.circuit_open', {
          requestId: details.requestId,
          provider: config.provider,
          model: config.model,
          outcome: 'deny',
          durationMs: 0,
          errorCategory: 'circuit-open',
        })

        return {
          kind: 'deny',
          reason:
            'Too many denials this turn; further requests are refused unreviewed until the next turn. Ask the user for explicit approval before retrying',
        }
      }

      const result = await runReview(runtime, details)
      const durationMs = Math.max(0, Date.now() - startedAt)
      if ('failure' in result) {
        circuitBreaker.recordNonDenial()
        logFailure(log, config, details, result, durationMs)

        return { kind: 'defer' }
      }

      const { assessment, contextDiagnostics } = result
      log.review(DECISION_EVENT, {
        requestId: details.requestId,
        provider: config.provider,
        model: config.model,
        riskLevel: assessment.riskLevel,
        userAuthorization: assessment.userAuthorization,
        outcome: assessment.outcome,
        durationMs,
        ...contextDiagnostics,
      })
      if (assessment.outcome === 'allow') {
        circuitBreaker.recordNonDenial()

        return { kind: 'allow' }
      }

      circuitBreaker.recordDenied()
      // The host already prefixes its own attribution sentence, so this carries only the why and the two grades.
      return {
        kind: 'deny',
        reason: `${assessment.rationale} (risk: ${assessment.riskLevel}, user authorization: ${assessment.userAuthorization})`,
      }
    } catch {
      // The chain does not isolate a link that throws, so every internal failure has to leave as a verdict.
      circuitBreaker.recordNonDenial()
      logFailure(log, config, details, { failure: 'internal-error' }, Math.max(0, Date.now() - startedAt))

      return { kind: 'defer' }
    }
  }
}
