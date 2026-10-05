import type { DenialCircuitBreaker } from './circuit-breaker.js'
import type { AutoReviewConfig } from './config.js'
import type { TranscriptStats } from './transcript.js'
import type { ReviewAssessment } from './verdict.js'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type {
  Authorizer,
  AuthorizerLog,
  AuthorizerVerdict,
  PromptPermissionDetails,
} from '@gotgenes/pi-permission-system'
import { resolveReviewModel } from './model.js'
import { POLICY_REVISION } from './policy.js'
import { buildReviewPrompt } from './prompt.js'
import { approximateTokens, findToolCallInput, renderTranscript } from './transcript.js'
import { parseReviewAssessment } from './verdict.js'

const RETRY_DELAYS_MS = [250, 1_000]
/** Room left for reasoning and the verdict when a prompt is admitted; pi-ai keeps its own margin on top. */
const OUTPUT_RESERVE_TOKENS = 16_384
const DECISION_EVENT = 'auto_review.decision'
// Upstream keys its reviewer as `guardian:{parent}` too: sharing the main session's key would let every review
// replace the main conversation's Codex WebSocket continuation.
const SESSION_KEY_PREFIX = 'auto-review:'
// Verbatim `REJECTION_INSTRUCTIONS` from openai/codex `codex-rs/prompts/src/model_messages/guardian.rs`.
const REJECTION_INSTRUCTIONS =
  'The agent must not attempt to achieve the same outcome via workaround, indirect execution, or policy circumvention. Proceed only with a materially safer alternative, or if the user explicitly approves the action after being informed of the risk. Otherwise, stop and request user input'

type FailureCategory =
  | 'provider-unresolved'
  | 'model-unresolved'
  | 'input-budget-exceeded'
  | 'provider-error'
  | 'invalid-response'
  | 'timeout'
  | 'cancelled'
  | 'internal-error'

export interface ReviewerRuntime {
  config: AutoReviewConfig
  /** Read at every review, since `signal` belongs to the turn in progress. */
  context: Pick<ExtensionContext, 'modelRegistry' | 'sessionManager' | 'signal'>
  circuitBreaker: DenialCircuitBreaker
  /** Aborted when the reviewer is replaced or the session ends. */
  sessionSignal: AbortSignal
}

interface ReviewDiagnostics extends TranscriptStats {
  policyRevision: string
  contextSource: 'active-branch'
  toolInputIncluded: boolean
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
}

type ReviewResult =
  | { assessment: ReviewAssessment; diagnostics: ReviewDiagnostics }
  | { failure: FailureCategory; diagnostics?: ReviewDiagnostics }

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
  const { config, context } = runtime
  const startedAt = Date.now()
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
      return { failure: 'cancelled' }
    }
    const branch = context.sessionManager.getBranch()
    const transcript = renderTranscript(branch)
    const toolInput = findToolCallInput(branch, details.toolCallId)
    const diagnostics: ReviewDiagnostics = {
      policyRevision: POLICY_REVISION,
      contextSource: 'active-branch',
      toolInputIncluded: toolInput !== undefined,
      ...transcript.stats,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
    }
    const failure = (category: FailureCategory): ReviewResult => ({ failure: category, diagnostics })
    const aborted = (): ReviewResult => failure(timeoutController.signal.aborted ? 'timeout' : 'cancelled')

    const resolved = resolveReviewModel(context.modelRegistry, config)
    if (!resolved.ok) {
      return failure(resolved.category)
    }
    const model = resolved.value
    const prompt = buildReviewPrompt(config, transcript, details, toolInput)
    if (approximateTokens(prompt.systemPrompt + prompt.userPrompt) + OUTPUT_RESERVE_TOKENS > model.contextWindow) {
      return failure('input-budget-exceeded')
    }

    for (let attempt = 0; ; attempt += 1) {
      let category: FailureCategory = 'provider-error'
      try {
        // The registry resolves the provider's authentication per request, so an unusable login lands here.
        const stream = context.modelRegistry.streamSimple(
          model,
          {
            systemPrompt: prompt.systemPrompt,
            messages: [{ role: 'user', content: prompt.userPrompt, timestamp: Date.now() }],
          },
          {
            maxRetries: 0,
            signal,
            timeoutMs: Math.max(1, config.timeoutMs - (Date.now() - startedAt)),
            // Gateways such as opencode-go also reject requests without a session id.
            sessionId: `${SESSION_KEY_PREFIX}${context.sessionManager.getSessionId()}`,
            ...(model.reasoning && config.reasoning !== 'off' ? { reasoning: config.reasoning } : {}),
          },
        )
        const message = await raceWithSignal(stream.result(), signal)
        diagnostics.inputTokens += message.usage.input
        diagnostics.cacheReadTokens += message.usage.cacheRead
        diagnostics.outputTokens += message.usage.output
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          throw new Error(message.errorMessage ?? message.stopReason)
        }
        category = 'invalid-response'
        const text = message.content
          .flatMap(block => (block.type === 'text' ? block.text : []))
          .join('')
          .trim()

        return { assessment: parseReviewAssessment(text), diagnostics }
      } catch {
        const delay = RETRY_DELAYS_MS[attempt]
        if (signal.aborted) {
          return aborted()
        }
        if (delay === undefined) {
          return failure(category)
        }
        await sleep(delay, signal)
        if (signal.aborted) {
          return aborted()
        }
      }
    }
  } finally {
    clearTimeout(timeout)
  }
}

function logFailure(
  log: AuthorizerLog,
  config: AutoReviewConfig,
  details: PromptPermissionDetails,
  result: { failure: FailureCategory; diagnostics?: ReviewDiagnostics },
  outcome: AuthorizerVerdict['kind'],
  durationMs: number,
): void {
  const entry = {
    requestId: details.requestId,
    provider: config.provider,
    model: config.model,
    outcome,
    errorCategory: result.failure,
    durationMs,
    ...result.diagnostics,
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
        // Deferring would open the human prompt the user just escaped, and Pi drops an interrupted call's verdict anyway.
        const verdict: AuthorizerVerdict =
          result.failure === 'cancelled'
            ? { kind: 'deny', reason: 'The automatic review was cancelled before it finished' }
            : { kind: 'defer' }
        circuitBreaker.recordNonDenial()
        logFailure(log, config, details, result, verdict.kind, durationMs)

        return verdict
      }

      const { assessment, diagnostics } = result
      log.review(DECISION_EVENT, {
        requestId: details.requestId,
        provider: config.provider,
        model: config.model,
        riskLevel: assessment.riskLevel,
        userAuthorization: assessment.userAuthorization,
        outcome: assessment.outcome,
        durationMs,
        ...diagnostics,
      })
      if (assessment.outcome === 'allow') {
        circuitBreaker.recordNonDenial()

        return { kind: 'allow' }
      }

      circuitBreaker.recordDenied()
      // The host already prefixes its own attribution sentence, so this carries the why, the two grades and upstream's
      // instruction against working around the denial.
      return {
        kind: 'deny',
        reason: `${assessment.rationale} (risk: ${assessment.riskLevel}, user authorization: ${assessment.userAuthorization}). ${REJECTION_INSTRUCTIONS}`,
      }
    } catch {
      // The chain does not isolate a link that throws, so every internal failure has to leave as a verdict.
      circuitBreaker.recordNonDenial()
      logFailure(log, config, details, { failure: 'internal-error' }, 'defer', Math.max(0, Date.now() - startedAt))

      return { kind: 'defer' }
    }
  }
}
