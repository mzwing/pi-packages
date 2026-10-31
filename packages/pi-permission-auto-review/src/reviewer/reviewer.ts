import type { AutoReviewConfig } from '../config/config.js'
import type { TranscriptStats } from '../prompt/transcript.js'
import type { DenialCircuitBreaker } from './circuit-breaker.js'
import type { ReviewAssessment } from './verdict.js'
import type { AssistantMessage, Message, Usage } from '@earendil-works/pi-ai'
import type { ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent'
import type {
  Authorizer,
  AuthorizerLog,
  AuthorizerVerdict,
  PromptPermissionDetails,
} from '@gotgenes/pi-permission-system'
import { calculateContextTokens } from '@earendil-works/pi-coding-agent'
import { buildSystemPrompt, POLICY_REVISION } from '../prompt/policy.js'
import { buildFollowUpPrompt, buildReviewPrompt } from '../prompt/review-prompt.js'
import { approximateTokens, findToolCallInput, renderTranscript } from '../prompt/transcript.js'
import { resolveReviewModel } from './model.js'
import { parseReviewAssessment } from './verdict.js'

const FIRST_RETRY_DELAY_MS = 250
const MAX_RETRY_DELAY_MS = 30_000
/** Room left for reasoning and the verdict when a prompt is admitted; pi-ai keeps its own margin on top */
const OUTPUT_RESERVE_TOKENS = 16_384
const DECISION_EVENT = 'auto_review.decision'
// Upstream keys its reviewer as `guardian:{parent}` too: sharing the main session's key would let every review
// replace the main conversation's Codex WebSocket continuation
const SESSION_KEY_PREFIX = 'auto-review:'
// Verbatim `REJECTION_INSTRUCTIONS` from openai/codex `codex-rs/prompts/src/model_messages/guardian.rs`
const REJECTION_INSTRUCTIONS =
  'The agent must not attempt to achieve the same outcome via workaround, indirect execution, or policy circumvention. Proceed only with a materially safer alternative, or if the user explicitly approves the action after being informed of the risk. Otherwise, stop and request user input'

type FailureCategory =
  | 'provider-unresolved'
  | 'model-unresolved'
  | 'input-budget-exceeded'
  | 'provider-error'
  | 'invalid-response'
  | 'attempt-timeout'
  | 'timeout'
  | 'cancelled'
  | 'internal-error'

export interface ReviewerRuntime {
  config: AutoReviewConfig
  /** Read at every review, since `signal` belongs to the turn in progress */
  context: Pick<ExtensionContext, 'modelRegistry' | 'sessionManager' | 'signal'>
  circuitBreaker: DenialCircuitBreaker
  /** Aborted when the reviewer is replaced or the session ends */
  sessionSignal: AbortSignal
}

/** The reviews of a session so far, which a follow-up review continues with what the session added since */
interface ReviewConversation {
  /** Each review's prompt and the reply to it */
  messages: Message[]
  lastSeenEntryId: string
  tokens: number
}

interface ReviewRequest {
  systemPrompt: string
  messages: Message[]
  transcriptStats: TranscriptStats
  /** Reviews the request continues */
  priorReviews: number
  tokens: number
}

// pi-permission-system masks every logged value whose key names a token or an authorization
interface ReviewDiagnostics extends TranscriptStats {
  policyRevision: string
  contextSource: 'active-branch'
  toolInputIncluded: boolean
  priorReviews: number
  usage: Pick<Usage, 'input' | 'cacheRead' | 'output'>
}

type ReviewResult =
  | { assessment: ReviewAssessment; diagnostics: ReviewDiagnostics; conversation: ReviewConversation | undefined }
  | { failure: FailureCategory; diagnostics?: ReviewDiagnostics }

function abortError(): Error {
  const error = new Error('operation aborted')
  error.name = 'AbortError'

  return error
}

/** Resolves early on abort; the caller checks the signal */
async function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  const onAbort = (): void => resolve()
  const timer = setTimeout(resolve, milliseconds)
  signal.addEventListener('abort', onAbort, { once: true })
  await promise
  clearTimeout(timer)
  signal.removeEventListener('abort', onAbort)
}

/** A provider is not bound to honour the abort signal promptly, so the timeout is enforced here */
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

function userMessage(content: string): Message {
  return { role: 'user', content, timestamp: Date.now() }
}

function replyText(message: AssistantMessage): string {
  return message.content
    .flatMap(block => (block.type === 'text' ? block.text : []))
    .join('')
    .trim()
}

/** A follow-up while the conversation still lies on the branch and has room for it, otherwise a full review */
function prepareRequest(
  config: AutoReviewConfig,
  branch: SessionEntry[],
  details: PromptPermissionDetails,
  toolInput: unknown,
  conversation: ReviewConversation | undefined,
  contextWindow: number,
): ReviewRequest {
  const lastSeen =
    conversation === undefined ? -1 : branch.findIndex(entry => entry.id === conversation.lastSeenEntryId)
  if (conversation !== undefined && lastSeen >= 0) {
    const transcript = renderTranscript(branch, lastSeen + 1)
    const userPrompt = buildFollowUpPrompt(transcript, details, toolInput)
    const tokens = conversation.tokens + approximateTokens(userPrompt)
    if (tokens + OUTPUT_RESERVE_TOKENS <= contextWindow) {
      return {
        systemPrompt: buildSystemPrompt(config),
        messages: [...conversation.messages, userMessage(userPrompt)],
        transcriptStats: transcript.stats,
        priorReviews: conversation.messages.length / 2,
        tokens,
      }
    }
  }
  const transcript = renderTranscript(branch)
  const prompt = buildReviewPrompt(config, transcript, details, toolInput)

  return {
    systemPrompt: prompt.systemPrompt,
    messages: [userMessage(prompt.userPrompt)],
    transcriptStats: transcript.stats,
    priorReviews: 0,
    tokens: approximateTokens(prompt.systemPrompt + prompt.userPrompt),
  }
}

/** In `auto`, a follow-up served without a cache hit ends the conversation, which an uncached provider would resend whole */
function nextConversation(
  config: AutoReviewConfig,
  request: ReviewRequest,
  reply: AssistantMessage,
  lastSeenEntryId: string | undefined,
): ReviewConversation | undefined {
  const continues =
    config.followUpReviews === 'always' ||
    (config.followUpReviews === 'auto' && (request.priorReviews === 0 || reply.usage.cacheRead > 0))
  if (!continues || lastSeenEntryId === undefined) {
    return undefined
  }

  return {
    messages: [...request.messages, reply],
    lastSeenEntryId,
    // A provider reporting no usage leaves an estimate, blind to hidden reasoning
    tokens: calculateContextTokens(reply.usage) || request.tokens + approximateTokens(replyText(reply)),
  }
}

async function runReview(
  runtime: ReviewerRuntime,
  details: PromptPermissionDetails,
  conversation: ReviewConversation | undefined,
): Promise<ReviewResult> {
  const { config, context } = runtime
  const deadline = Date.now() + config.timeoutMs
  const timeoutController = new AbortController()
  const timeout = setTimeout(() => timeoutController.abort(), config.timeoutMs)
  const turnSignal = context.signal
  const reviewSignal = AbortSignal.any([
    timeoutController.signal,
    runtime.sessionSignal,
    ...(turnSignal === undefined ? [] : [turnSignal]),
  ])

  try {
    if (reviewSignal.aborted) {
      return { failure: 'cancelled' }
    }
    const resolved = resolveReviewModel(context.modelRegistry, config)
    if (!resolved.ok) {
      return { failure: resolved.category }
    }
    const model = resolved.value
    const branch = context.sessionManager.getBranch()
    const toolInput = findToolCallInput(branch, details.toolCallId)
    const request = prepareRequest(config, branch, details, toolInput, conversation, model.contextWindow)
    const diagnostics: ReviewDiagnostics = {
      policyRevision: POLICY_REVISION,
      contextSource: 'active-branch',
      toolInputIncluded: toolInput !== undefined,
      ...request.transcriptStats,
      priorReviews: request.priorReviews,
      usage: { input: 0, cacheRead: 0, output: 0 },
    }
    const failure = (category: FailureCategory): ReviewResult => ({ failure: category, diagnostics })
    const aborted = (): ReviewResult => failure(timeoutController.signal.aborted ? 'timeout' : 'cancelled')
    if (request.tokens + OUTPUT_RESERVE_TOKENS > model.contextWindow) {
      return failure('input-budget-exceeded')
    }

    const attemptTimeoutMs = config.attemptTimeoutMs ?? config.timeoutMs
    for (let attempt = 0; ; attempt += 1) {
      const attemptController = new AbortController()
      const attemptTimeout = setTimeout(() => attemptController.abort(), attemptTimeoutMs)
      const attemptSignal = AbortSignal.any([reviewSignal, attemptController.signal])
      let category: FailureCategory = 'provider-error'
      try {
        // The registry resolves the provider's authentication per request, so an unusable login lands here
        const stream = context.modelRegistry.streamSimple(
          model,
          { systemPrompt: request.systemPrompt, messages: request.messages },
          {
            maxRetries: 0,
            signal: attemptSignal,
            timeoutMs: Math.max(1, Math.min(attemptTimeoutMs, deadline - Date.now())),
            // Gateways such as opencode-go also reject requests without a session id
            sessionId: `${SESSION_KEY_PREFIX}${context.sessionManager.getSessionId()}`,
            ...(model.reasoning && config.reasoning !== 'off' ? { reasoning: config.reasoning } : {}),
          },
        )
        const message = await raceWithSignal(stream.result(), attemptSignal)
        diagnostics.usage.input += message.usage.input
        diagnostics.usage.cacheRead += message.usage.cacheRead
        diagnostics.usage.output += message.usage.output
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          throw new Error(message.errorMessage ?? message.stopReason)
        }
        category = 'invalid-response'

        return {
          assessment: parseReviewAssessment(replyText(message)),
          diagnostics,
          conversation: nextConversation(config, request, message, branch.at(-1)?.id),
        }
      } catch {
        if (reviewSignal.aborted) {
          return aborted()
        }
        if (attempt >= config.maxRetries) {
          return failure(attemptController.signal.aborted ? 'attempt-timeout' : category)
        }
      } finally {
        clearTimeout(attemptTimeout)
      }
      await sleep(Math.min(FIRST_RETRY_DELAY_MS * 4 ** attempt, MAX_RETRY_DELAY_MS), reviewSignal)
      if (reviewSignal.aborted) {
        return aborted()
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
  // As upstream keeps it: concurrent reviews each continue the conversation they started from, and the last to finish wins
  let conversation: ReviewConversation | undefined

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

      const result = await runReview(runtime, details, conversation)
      const durationMs = Math.max(0, Date.now() - startedAt)
      if ('failure' in result) {
        // The conversation may be what failed, such as one too long for the provider; an interruption says nothing of it
        if (result.failure !== 'cancelled') {
          conversation = undefined
        }
        // Deferring would open the human prompt the user just escaped, and Pi drops an interrupted call's verdict anyway
        const verdict: AuthorizerVerdict =
          result.failure === 'cancelled'
            ? { kind: 'deny', reason: 'The automatic review was cancelled before it finished' }
            : { kind: 'defer' }
        circuitBreaker.recordNonDenial()
        logFailure(log, config, details, result, verdict.kind, durationMs)

        return verdict
      }

      const { assessment, diagnostics } = result
      conversation = result.conversation
      log.review(DECISION_EVENT, {
        requestId: details.requestId,
        provider: config.provider,
        model: config.model,
        riskLevel: assessment.riskLevel,
        // Under a key naming an authorization, the review log would mask it
        userApproval: assessment.userAuthorization,
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
      // instruction against working around the denial
      return {
        kind: 'deny',
        reason: `${assessment.rationale} (risk: ${assessment.riskLevel}, user authorization: ${assessment.userAuthorization}). ${REJECTION_INSTRUCTIONS}`,
      }
    } catch {
      // The chain does not isolate a link that throws, so every internal failure has to leave as a verdict
      conversation = undefined
      circuitBreaker.recordNonDenial()
      logFailure(log, config, details, { failure: 'internal-error' }, 'defer', Math.max(0, Date.now() - startedAt))

      return { kind: 'defer' }
    }
  }
}
