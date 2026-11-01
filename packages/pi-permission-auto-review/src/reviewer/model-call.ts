import type { AutoReviewConfig } from '../config/config.js'
import type { Api, AssistantMessage, Message, Model, Usage } from '@earendil-works/pi-ai'
import type { ModelRegistry } from '@earendil-works/pi-coding-agent'

const FIRST_RETRY_DELAY_MS = 250
const MAX_RETRY_DELAY_MS = 30_000
/** Room left for reasoning and the verdict when a prompt is admitted; pi-ai keeps its own margin on top */
export const OUTPUT_RESERVE_TOKENS = 16_384
// Upstream keys its reviewer as `guardian:{parent}` too: sharing the main session's key would let every review
// replace the main conversation's Codex WebSocket continuation
const SESSION_KEY_PREFIX = 'auto-review:'

export type CallFailure =
  | 'input-budget-exceeded'
  | 'provider-error'
  | 'invalid-response'
  | 'attempt-timeout'
  | 'timeout'
  | 'cancelled'

export type CallUsage = Pick<Usage, 'input' | 'cacheRead' | 'output'>

export interface ModelRequest {
  systemPrompt: string
  messages: Message[]
  /** The prompt's size, admitted against the model's context window before the first attempt */
  tokens: number
  reasoning: AutoReviewConfig['reasoning']
  maxTokens?: number | undefined
}

type CallResult<T> = { ok: true; value: T; reply: AssistantMessage } | { ok: false; failure: CallFailure }

/** A `parse` that throws marks the reply malformed, which is retried like a failed call */
export type ModelCall = <T>(request: ModelRequest, parse: (text: string) => T) => Promise<CallResult<T>>

export interface ModelCallOptions {
  registry: ModelRegistry
  model: Model<Api>
  config: AutoReviewConfig
  sessionId: string
  /** Ends every call of the review: its total timeout, the session, or the turn */
  signal: AbortSignal
  /** The review's total timeout alone, which tells a timeout apart from a cancellation */
  timeoutSignal: AbortSignal
  deadline: number
  /** Every call adds its usage here, retries included */
  usage: CallUsage
}

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

export function replyText(message: AssistantMessage): string {
  return message.content
    .flatMap(block => (block.type === 'text' ? block.text : []))
    .join('')
    .trim()
}

export function createModelCall(options: ModelCallOptions): ModelCall {
  const { registry, model, config, signal, timeoutSignal, deadline, usage } = options
  const attemptTimeoutMs = config.attemptTimeoutMs ?? config.timeoutMs
  const aborted = (): CallResult<never> => ({ ok: false, failure: timeoutSignal.aborted ? 'timeout' : 'cancelled' })

  return async (request, parse) => {
    if (signal.aborted) {
      return aborted()
    }
    if (request.tokens + OUTPUT_RESERVE_TOKENS > model.contextWindow) {
      return { ok: false, failure: 'input-budget-exceeded' }
    }

    for (let attempt = 0; ; attempt += 1) {
      const attemptController = new AbortController()
      const attemptTimeout = setTimeout(() => attemptController.abort(), attemptTimeoutMs)
      const attemptSignal = AbortSignal.any([signal, attemptController.signal])
      let failure: CallFailure = 'provider-error'
      try {
        // The registry resolves the provider's authentication per request, so an unusable login lands here
        const stream = registry.streamSimple(
          model,
          { systemPrompt: request.systemPrompt, messages: request.messages },
          {
            maxRetries: 0,
            signal: attemptSignal,
            timeoutMs: Math.max(1, Math.min(attemptTimeoutMs, deadline - Date.now())),
            // Gateways such as opencode-go also reject requests without a session id
            sessionId: `${SESSION_KEY_PREFIX}${options.sessionId}`,
            ...(model.reasoning && request.reasoning !== 'off' ? { reasoning: request.reasoning } : {}),
            ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
          },
        )
        const reply = await raceWithSignal(stream.result(), attemptSignal)
        usage.input += reply.usage.input
        usage.cacheRead += reply.usage.cacheRead
        usage.output += reply.usage.output
        if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
          throw new Error(reply.errorMessage ?? reply.stopReason)
        }
        failure = 'invalid-response'

        return { ok: true, value: parse(replyText(reply)), reply }
      } catch {
        if (signal.aborted) {
          return aborted()
        }
        if (attempt >= config.maxRetries) {
          return { ok: false, failure: attemptController.signal.aborted ? 'attempt-timeout' : failure }
        }
      } finally {
        clearTimeout(attemptTimeout)
      }
      await sleep(Math.min(FIRST_RETRY_DELAY_MS * 4 ** attempt, MAX_RETRY_DELAY_MS), signal)
      if (signal.aborted) {
        return aborted()
      }
    }
  }
}
