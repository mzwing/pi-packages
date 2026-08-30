import type { DenialCircuitBreaker } from './circuit-breaker.js'
import type { AutoReviewConfig } from './config.js'
import type { ReviewModelRegistry } from './model.js'
import type { TranscriptStats } from './transcript.js'
import type { ReviewAssessment } from './verdict.js'
import type { AssistantMessage, Provider, ProviderHeaders, SimpleStreamOptions } from '@earendil-works/pi-ai'
import type { SessionManager } from '@earendil-works/pi-coding-agent'
import type { Authorizer, AuthorizerLog, PromptPermissionDetails } from '@gotgenes/pi-permission-system'
import { resolveReviewModel } from './model.js'
import { POLICY_REVISION } from './policy.js'
import { buildReviewPrompt } from './prompt.js'
import { renderTranscript } from './transcript.js'
import { parseReviewAssessment } from './verdict.js'

const RETRY_DELAYS_MS = [250, 1_000]
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1
const MAX_OUTPUT_TOKENS = 1_000
const DECISION_EVENT = 'auto_review.decision'
const FAILURE_EVENT = 'auto_review.failure'
const CIRCUIT_OPEN_EVENT = 'auto_review.circuit_open'

type FailureCategory =
  | 'provider-unresolved'
  | 'model-unresolved'
  | 'auth-unresolved'
  | 'provider-error'
  | 'invalid-response'
  | 'timeout'
  | 'cancelled'
  | 'internal-error'

export interface ReviewerRuntime {
  config: AutoReviewConfig
  registry: ReviewModelRegistry
  sessionManager: Pick<SessionManager, 'getBranch'>
  circuitBreaker: DenialCircuitBreaker
  sessionSignal?: AbortSignal
}

/** The clock and timer, injectable so a test does not wait out a real retry delay. */
export interface ReviewerDependencies {
  now?: () => number
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

interface ContextDiagnostics extends TranscriptStats {
  policyRevision: string
  contextSource: 'active-branch'
}

interface Failure {
  category: FailureCategory
  contextDiagnostics?: ContextDiagnostics
}

interface ReviewCallResult {
  assessment: ReviewAssessment
  contextDiagnostics: ContextDiagnostics
}

function abortError(): Error {
  const error = new Error('operation aborted')
  error.name = 'AbortError'
  return error
}

async function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(abortError())
      },
      { once: true },
    )
  })
}

async function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortError())
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

function responseText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is Extract<(typeof message.content)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim()
}

function buildStreamOptions(
  runtime: ReviewerRuntime,
  signal: AbortSignal,
  timeoutMs: number,
  auth: {
    apiKey?: string
    headers?: ProviderHeaders
    env?: Record<string, string>
  },
  reasoning: boolean,
): SimpleStreamOptions {
  const options: SimpleStreamOptions = {
    maxRetries: 0,
    maxTokens: MAX_OUTPUT_TOKENS,
    signal,
    timeoutMs,
  }
  if (auth.apiKey !== undefined) {
    options.apiKey = auth.apiKey
  }
  if (auth.headers !== undefined) {
    options.headers = auth.headers
  }
  if (auth.env !== undefined) {
    options.env = auth.env
  }
  if (reasoning && runtime.config.reasoning !== 'off') {
    options.reasoning = runtime.config.reasoning
  }
  return options
}

async function callProvider(
  provider: Provider,
  model: Parameters<Provider['streamSimple']>[0],
  systemPrompt: string,
  userPrompt: string,
  options: SimpleStreamOptions,
): Promise<AssistantMessage> {
  const stream = provider.streamSimple(
    model,
    {
      systemPrompt,
      messages: [
        {
          role: 'user',
          content: userPrompt,
          timestamp: Date.now(),
        },
      ],
    },
    options,
  )
  return stream.result()
}

function writeFailure(
  log: AuthorizerLog,
  runtime: ReviewerRuntime,
  details: PromptPermissionDetails,
  failure: Failure,
  durationMs: number,
): void {
  const common = {
    requestId: details.requestId,
    provider: runtime.config.provider,
    model: runtime.config.model,
    outcome: 'defer',
    errorCategory: failure.category,
    durationMs,
    ...failure.contextDiagnostics,
  }
  log.review(DECISION_EVENT, common)
  log.debug(FAILURE_EVENT, common)
}

async function runReview(
  runtime: ReviewerRuntime,
  details: PromptPermissionDetails,
  dependencies: Required<ReviewerDependencies>,
): Promise<ReviewCallResult | Failure> {
  const startedAt = dependencies.now()
  const timeoutController = new AbortController()
  const timeout = setTimeout(() => timeoutController.abort(), runtime.config.timeoutMs)
  const signal =
    runtime.sessionSignal === undefined
      ? timeoutController.signal
      : AbortSignal.any([timeoutController.signal, runtime.sessionSignal])

  try {
    const transcript = renderTranscript(runtime.sessionManager.getBranch())
    const contextDiagnostics: ContextDiagnostics = {
      policyRevision: POLICY_REVISION,
      contextSource: 'active-branch',
      ...transcript.stats,
    }
    const failure = (category: FailureCategory): Failure => ({ category, contextDiagnostics })
    const resolved = resolveReviewModel(runtime.registry, runtime.config)
    if (!resolved.ok) {
      return failure(resolved.category)
    }

    let auth
    try {
      auth = await raceWithSignal(runtime.registry.getApiKeyAndHeaders(resolved.value.model), signal)
    } catch {
      if (signal.aborted) {
        return failure(timeoutController.signal.aborted ? 'timeout' : 'cancelled')
      }
      return failure('auth-unresolved')
    }
    if (!auth.ok) {
      return failure('auth-unresolved')
    }

    const prompt = buildReviewPrompt(runtime.config, transcript, details)

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const remainingMs = Math.max(1, runtime.config.timeoutMs - (dependencies.now() - startedAt))
        const message = await raceWithSignal(
          callProvider(
            resolved.value.provider,
            resolved.value.model,
            prompt.systemPrompt,
            prompt.userPrompt,
            buildStreamOptions(runtime, signal, remainingMs, auth, resolved.value.model.reasoning),
          ),
          signal,
        )

        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          throw new Error(message.errorMessage ?? message.stopReason)
        }

        try {
          return {
            assessment: parseReviewAssessment(responseText(message)),
            contextDiagnostics,
          }
        } catch {
          return failure('invalid-response')
        }
      } catch {
        if (signal.aborted) {
          return failure(timeoutController.signal.aborted ? 'timeout' : 'cancelled')
        }
        if (attempt >= MAX_ATTEMPTS) {
          return failure('provider-error')
        }
        try {
          await dependencies.sleep(RETRY_DELAYS_MS[attempt - 1] ?? 0, signal)
        } catch {
          return failure(timeoutController.signal.aborted ? 'timeout' : 'cancelled')
        }
      }
    }
    return failure('provider-error')
  } finally {
    clearTimeout(timeout)
  }
}

export function createPermissionReviewer(
  runtime: ReviewerRuntime,
  reviewerDependencies: ReviewerDependencies = {},
): Authorizer['authorize'] {
  const dependencies: Required<ReviewerDependencies> = {
    now: reviewerDependencies.now ?? Date.now,
    sleep: reviewerDependencies.sleep ?? defaultSleep,
  }

  return async (details, _query, log) => {
    const startedAt = dependencies.now()
    try {
      if (runtime.circuitBreaker.isOpen()) {
        const reason =
          'Too many denials this turn; further requests are refused unreviewed until the next turn. Ask the user for explicit approval before retrying'
        log.review(CIRCUIT_OPEN_EVENT, {
          requestId: details.requestId,
          provider: runtime.config.provider,
          model: runtime.config.model,
          outcome: 'deny',
          durationMs: 0,
          errorCategory: 'circuit-open',
        })
        return { kind: 'deny', reason }
      }

      const result = await runReview(runtime, details, dependencies)
      const durationMs = Math.max(0, dependencies.now() - startedAt)
      if ('category' in result) {
        runtime.circuitBreaker.recordNonDenial()
        writeFailure(log, runtime, details, result, durationMs)
        return { kind: 'defer' }
      }

      const { assessment, contextDiagnostics } = result
      log.review(DECISION_EVENT, {
        requestId: details.requestId,
        provider: runtime.config.provider,
        model: runtime.config.model,
        riskLevel: assessment.riskLevel,
        userAuthorization: assessment.userAuthorization,
        outcome: assessment.outcome,
        durationMs,
        ...contextDiagnostics,
      })

      if (assessment.outcome === 'allow') {
        runtime.circuitBreaker.recordNonDenial()
        return { kind: 'allow' }
      }

      runtime.circuitBreaker.recordDenied()
      // The reason is rendered after the host's own attribution sentence
      // ("The 'auto-review' authorizer denied this ..."), so it carries only
      // what that sentence does not: why, and the two grades behind the call.
      return {
        kind: 'deny',
        reason: `${assessment.rationale} (risk: ${assessment.riskLevel}, user authorization: ${assessment.userAuthorization})`,
      }
    } catch {
      // The chain does not isolate a link that throws, so every internal failure
      // has to leave here as a verdict.
      runtime.circuitBreaker.recordNonDenial()
      writeFailure(log, runtime, details, { category: 'internal-error' }, Math.max(0, dependencies.now() - startedAt))
      return { kind: 'defer' }
    }
  }
}
