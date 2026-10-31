import type { AutoReviewConfig } from '../../src/config/config.js'
import type { AssistantMessage, SimpleStreamOptions } from '@earendil-works/pi-ai'
import type { ModelRegistry, SessionEntry } from '@earendil-works/pi-coding-agent'
import type { AuthorizerLog, PermissionQuery, PromptPermissionDetails } from '@gotgenes/pi-permission-system'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { POLICY_REVISION } from '../../src/prompt/policy.js'
import { DenialCircuitBreaker } from '../../src/reviewer/circuit-breaker.js'
import { createPermissionReviewer } from '../../src/reviewer/reviewer.js'
import { permissionDetails } from '../helpers.js'

const ALLOW = '{"outcome":"allow"}'
const DENY =
  '{"risk_level":"high","user_authorization":"unknown","outcome":"deny","rationale":"Publishing was not authorized."}'

const STALLED_REPLY = new Promise<AssistantMessage>(() => {})

const USER_ENTRY = {
  type: 'message',
  id: 'user-1',
  parentId: null,
  timestamp: '2026-07-23T00:00:00.000Z',
  message: { role: 'user', content: 'Please run the requested operation.', timestamp: 0 },
} as SessionEntry

function reply(text: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason,
    usage: { input: 100, output: 10, cacheRead: 40 },
  } as AssistantMessage
}

function toolCallEntry(input: Record<string, unknown>): SessionEntry {
  return {
    type: 'message',
    id: 'assistant-1',
    parentId: 'user-1',
    timestamp: '2026-07-23T00:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-1', name: 'write', arguments: input }],
      timestamp: 0,
    },
  } as SessionEntry
}

interface HarnessOptions {
  replies?: (AssistantMessage | Error | Promise<AssistantMessage>)[]
  config?: Partial<AutoReviewConfig>
  getProvider?: () => unknown
  entries?: SessionEntry[]
  turnSignal?: AbortSignal
}

function createHarness(options: HarnessOptions = {}) {
  const replies = [...(options.replies ?? [reply(ALLOW)])]
  const callTimes: number[] = []
  const streamSimple = vi.fn(
    (_model: unknown, _context: { messages: { content: string }[] }, _options: SimpleStreamOptions) => ({
      result: async () => {
        callTimes.push(Date.now())
        const next = replies.shift() ?? new Error('no scripted reply')
        if (next instanceof Error) {
          throw next
        }

        return next
      },
    }),
  )
  const model = {
    id: 'review-model',
    provider: 'custom-review',
    api: 'openai-responses',
    reasoning: true,
    contextWindow: 200_000,
  }
  const registry = {
    find: () => model,
    getProvider: options.getProvider ?? (() => ({ id: 'custom-review' })),
    streamSimple,
  } as unknown as ModelRegistry
  const circuitBreaker = new DenialCircuitBreaker()
  const reviewer = createPermissionReviewer({
    config: { ...DEFAULT_CONFIG, provider: 'custom-review', model: 'review-model', ...options.config },
    context: {
      modelRegistry: registry,
      sessionManager: { getBranch: () => options.entries ?? [USER_ENTRY], getSessionId: () => 'session-1' },
      signal: options.turnSignal,
    } as never,
    circuitBreaker,
    sessionSignal: new AbortController().signal,
  })

  function start(requestId = 'request-1', details: Partial<PromptPermissionDetails> = {}) {
    const review = vi.fn<AuthorizerLog['review']>()
    const verdict = reviewer(permissionDetails({ requestId, ...details }), {} as PermissionQuery, {
      review,
      debug: vi.fn(),
    })

    return { verdict, entries: review.mock.calls }
  }

  return {
    circuitBreaker,
    streamSimple,
    callTimes,
    start,
    /** Runs the retry delays and the review timeout on the fake clock */
    async authorize(requestId = 'request-1', details: Partial<PromptPermissionDetails> = {}) {
      const { verdict, entries } = start(requestId, details)
      await vi.runAllTimersAsync()

      return { verdict: await verdict, entries }
    },
  }
}

describe('permission reviewer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks a tool-free model call and logs where its evidence came from', async () => {
    const harness = createHarness()
    const { verdict, entries } = await harness.authorize()
    const [, context, options] = harness.streamSimple.mock.calls[0] ?? []

    expect(verdict).toEqual({ kind: 'allow' })
    expect(context).not.toHaveProperty('tools')
    // Retries stay inside the review's own budget, reasoning is not starved by an output cap, and the review keeps a
    // session key apart from the main conversation's
    expect(options).toMatchObject({ maxRetries: 0, sessionId: 'auto-review:session-1' })
    expect(options).not.toHaveProperty('maxTokens')
    expect(entries[0]?.[1]).toMatchObject({
      policyRevision: POLICY_REVISION,
      contextSource: 'active-branch',
      toolInputIncluded: false,
      directUserEntriesRetained: 1,
      latestTrustedEntryRetained: true,
      inputTokens: 100,
      cacheReadTokens: 40,
      outputTokens: 10,
    })
  })

  it('returns a denial that teaches and forbids workarounds, without writing the rationale to the log', async () => {
    const { verdict, entries } = await createHarness({ replies: [reply(DENY)] }).authorize()

    expect(verdict.kind === 'deny' ? verdict.reason : undefined).toMatch(
      /^Publishing was not authorized\. \(risk: high, user authorization: unknown\)\. The agent must not attempt to achieve the same outcome via workaround/,
    )
    expect(entries[0]?.[1]).toMatchObject({ outcome: 'deny', riskLevel: 'high' })
    expect(entries[0]?.[1]).not.toHaveProperty('rationale')
  })

  it('shows the reviewer the complete input of the tool call that raised the ask', async () => {
    const content = 'x'.repeat(50_000)
    const harness = createHarness({ entries: [USER_ENTRY, toolCallEntry({ path: 'notes.md', content })] })
    const { entries } = await harness.authorize('request-1', { toolCallId: 'call-1' })
    const [, context] = harness.streamSimple.mock.calls[0] ?? []

    expect(context?.messages[0]?.content).toContain(content)
    expect(entries[0]?.[1]).toMatchObject({ toolInputIncluded: true })
  })

  it('defers an action too large for the reviewer to see whole, without calling it', async () => {
    const harness = createHarness({
      entries: [USER_ENTRY, toolCallEntry({ path: 'dump.json', content: 'x'.repeat(1_000_000) })],
    })
    const { verdict, entries } = await harness.authorize('request-1', { toolCallId: 'call-1' })

    expect(verdict).toEqual({ kind: 'defer' })
    expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'input-budget-exceeded' })
    expect(harness.streamSimple).not.toHaveBeenCalled()
  })

  it('retries a transient provider failure within the same review', async () => {
    const harness = createHarness({ replies: [new Error('temporary failure'), reply('', 'error'), reply(ALLOW)] })

    expect((await harness.authorize()).verdict).toEqual({ kind: 'allow' })
    expect(harness.streamSimple).toHaveBeenCalledTimes(3)
  })

  it('retries a malformed reply, and defers to the human prompt once every attempt has failed', async () => {
    expect((await createHarness({ replies: [reply('not json'), reply(ALLOW)] }).authorize()).verdict).toEqual({
      kind: 'allow',
    })

    const malformed = await createHarness({
      replies: [reply('not json'), reply('not json'), reply('not json')],
    }).authorize()
    expect(malformed.verdict).toEqual({ kind: 'defer' })
    // Every reply is paid for, including the ones that were retried
    expect(malformed.entries[0]?.[1]).toMatchObject({ errorCategory: 'invalid-response', inputTokens: 300 })

    // Request-time authentication fails inside the registry stream, so an unusable login arrives here too
    const failing = createHarness({ replies: [new Error('no login'), new Error('no login'), new Error('no login')] })
    const exhausted = await failing.authorize()
    expect(exhausted.verdict).toEqual({ kind: 'defer' })
    expect(exhausted.entries[0]?.[1]).toMatchObject({ errorCategory: 'provider-error' })
    expect(failing.streamSimple).toHaveBeenCalledTimes(3)
  })

  // The authorizer chain does not isolate a link that throws
  it('defers rather than throw when the reviewer provider is missing or its lookup throws', async () => {
    const missing = await createHarness({ getProvider: () => undefined }).authorize()
    const throwing = await createHarness({
      getProvider: () => {
        throw new Error('provider lookup failed')
      },
    }).authorize()

    expect(missing).toMatchObject({ verdict: { kind: 'defer' } })
    expect(missing.entries[0]?.[1]).toMatchObject({ errorCategory: 'provider-unresolved' })
    expect(throwing).toMatchObject({ verdict: { kind: 'defer' } })
    expect(throwing.entries[0]?.[1]).toMatchObject({ errorCategory: 'internal-error' })
  })

  it('refuses unreviewed for the rest of the turn after three consecutive denials', async () => {
    const harness = createHarness({ replies: [reply(DENY), reply(DENY), reply(DENY)] })
    for (let index = 0; index < 3; index += 1) {
      await harness.authorize(`request-${index}`)
    }
    const { verdict, entries } = await harness.authorize('request-3')

    expect(verdict.kind === 'deny' ? verdict.reason : undefined).toContain('explicit approval')
    expect(entries[0]?.[0]).toBe('auto_review.circuit_open')
    expect(harness.streamSimple).toHaveBeenCalledTimes(3)
  })

  it('refuses after ten denials in the recent window too, until the next turn', async () => {
    const harness = createHarness({ replies: Array.from({ length: 10 }, () => [reply(DENY), reply(ALLOW)]).flat() })
    for (let index = 0; index < 19; index += 1) {
      await harness.authorize(`request-${index}`)
    }

    expect((await harness.authorize('request-19')).verdict).toMatchObject({ kind: 'deny' })
    expect(harness.streamSimple).toHaveBeenCalledTimes(19)

    harness.circuitBreaker.resetTurn()
    expect((await harness.authorize('request-20')).verdict).toEqual({ kind: 'allow' })
  })

  it('aborts at the total timeout and defers', async () => {
    const { verdict, entries } = await createHarness({
      config: { timeoutMs: 5 },
      replies: [STALLED_REPLY],
    }).authorize()

    expect(verdict).toEqual({ kind: 'defer' })
    expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'timeout' })
  })

  it('denies at once when the turn is interrupted, and spends no call on an ask raised after it', async () => {
    const turn = new AbortController()
    const harness = createHarness({ turnSignal: turn.signal, replies: [STALLED_REPLY] })
    const { verdict, entries } = harness.start()
    turn.abort()

    expect(await verdict).toMatchObject({ kind: 'deny' })
    expect(entries[0]?.[1]).toMatchObject({ outcome: 'deny', errorCategory: 'cancelled' })

    expect((await harness.authorize('request-2')).verdict).toMatchObject({ kind: 'deny' })
    expect(harness.streamSimple).toHaveBeenCalledOnce()
  })

  describe('retries', () => {
    const failures = (count: number): Error[] => Array.from({ length: count }, () => new Error('temporary failure'))

    it('retries maxRetries times, backing off to at most 30 s between calls', async () => {
      const harness = createHarness({
        config: { maxRetries: 7, timeoutMs: 300_000 },
        replies: [...failures(7), reply(ALLOW)],
      })

      expect((await harness.authorize()).verdict).toEqual({ kind: 'allow' })
      expect(harness.callTimes).toEqual([0, 250, 1_250, 5_250, 21_250, 51_250, 81_250, 111_250])
    })

    it('makes a single call when maxRetries is 0', async () => {
      const harness = createHarness({ config: { maxRetries: 0 }, replies: [...failures(1), reply(ALLOW)] })
      const { verdict, entries } = await harness.authorize()

      expect(verdict).toEqual({ kind: 'defer' })
      expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'provider-error' })
      expect(harness.streamSimple).toHaveBeenCalledOnce()
    })

    it('abandons a call at attemptTimeoutMs and retries it, even if the provider ignores the abort', async () => {
      const lateDenial = new Promise<AssistantMessage>(resolve => setTimeout(resolve, 1_100, reply(DENY)))
      const harness = createHarness({ config: { attemptTimeoutMs: 1_000 }, replies: [lateDenial, reply(ALLOW)] })
      const { verdict } = await harness.authorize()
      const [, , options] = harness.streamSimple.mock.calls[0] ?? []

      expect(verdict).toEqual({ kind: 'allow' })
      expect(options).toMatchObject({ timeoutMs: 1_000 })
      expect(options?.signal?.aborted).toBe(true)
    })

    it('defers with attempt-timeout once every attempt has timed out', async () => {
      const harness = createHarness({
        config: { maxRetries: 1, attemptTimeoutMs: 1_000 },
        replies: [STALLED_REPLY, STALLED_REPLY],
      })
      const { verdict, entries } = await harness.authorize()

      expect(verdict).toEqual({ kind: 'defer' })
      expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'attempt-timeout' })
      expect(harness.streamSimple).toHaveBeenCalledTimes(2)
    })

    it('keeps every call and backoff within timeoutMs, however long attemptTimeoutMs is', async () => {
      const harness = createHarness({
        config: { timeoutMs: 1_000, maxRetries: 5, attemptTimeoutMs: 60_000 },
        replies: [...failures(2), reply(ALLOW)],
      })
      const { verdict, entries } = await harness.authorize()

      expect(verdict).toEqual({ kind: 'defer' })
      expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'timeout', durationMs: 1_000 })
      expect(harness.callTimes).toEqual([0, 250])
      expect(harness.streamSimple.mock.calls.map(([, , options]) => options.timeoutMs)).toEqual([1_000, 750])
    })

    it('denies at once when the turn is interrupted during a backoff, leaving no call or timer behind', async () => {
      const turn = new AbortController()
      const harness = createHarness({ turnSignal: turn.signal, replies: [...failures(1), reply(ALLOW)] })
      const { verdict, entries } = harness.start()
      await vi.advanceTimersByTimeAsync(100)
      turn.abort()

      expect(await verdict).toMatchObject({ kind: 'deny' })
      expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'cancelled', durationMs: 100 })
      expect(harness.streamSimple).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})
