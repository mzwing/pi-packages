import type { AutoReviewConfig } from '../src/review.js'
import type { AssistantMessage, SimpleStreamOptions } from '@earendil-works/pi-ai'
import type { ModelRegistry, SessionEntry } from '@earendil-works/pi-coding-agent'
import type { AuthorizerLog, PermissionQuery, PromptPermissionDetails } from '@gotgenes/pi-permission-system'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DenialCircuitBreaker } from '../src/circuit-breaker.js'
import { POLICY_REVISION } from '../src/policy.js'
import { createPermissionReviewer } from '../src/reviewer.js'
import { permissionDetails } from './helpers.js'

const ALLOW = '{"outcome":"allow"}'
const DENY =
  '{"risk_level":"high","user_authorization":"unknown","outcome":"deny","rationale":"Publishing was not authorized."}'

const LEGACY_CONFIG: AutoReviewConfig = {
  provider: 'custom-review',
  model: 'review-model',
  reasoning: 'low',
  timeoutMs: 90_000,
  includeBaselinePolicy: true,
}

const HANG = new Promise<AssistantMessage>(() => {})

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

async function later(milliseconds: number, message: AssistantMessage): Promise<AssistantMessage> {
  await new Promise(resolve => setTimeout(resolve, milliseconds))

  return message
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
  /** Replaces the scripted replies, e.g. to wait on the abort signal. */
  respond?: (options: SimpleStreamOptions) => Promise<AssistantMessage>
  getProvider?: () => unknown
  entries?: SessionEntry[]
  turnSignal?: AbortSignal
  sessionSignal?: AbortSignal
}

function createHarness(options: HarnessOptions = {}) {
  const replies = [...(options.replies ?? [reply(ALLOW)])]
  let startedAt = 0
  const callTimes: number[] = []
  const streamSimple = vi.fn(
    (_model: unknown, _context: { messages: { content: string }[] }, streamOptions: SimpleStreamOptions) => ({
      result: async () => {
        callTimes.push(Date.now() - startedAt)
        if (options.respond !== undefined) {
          return options.respond(streamOptions)
        }
        const next = replies.shift()
        if (next instanceof Promise) {
          return next
        }
        if (next === undefined || next instanceof Error) {
          throw next ?? new Error('no scripted reply')
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
    config: { ...LEGACY_CONFIG, ...options.config },
    context: {
      modelRegistry: registry,
      sessionManager: { getBranch: () => options.entries ?? [USER_ENTRY], getSessionId: () => 'session-1' },
      signal: options.turnSignal,
    } as never,
    circuitBreaker,
    sessionSignal: options.sessionSignal ?? new AbortController().signal,
  })

  function start(requestId = 'request-1', details: Partial<PromptPermissionDetails> = {}) {
    const review = vi.fn<AuthorizerLog['review']>()
    startedAt = Date.now()
    callTimes.length = 0
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
    callOptions: () => streamSimple.mock.calls.map(([, , streamOptions]) => streamOptions),
    /** Runs the retry delays and the review timeout on the fake clock. */
    async authorize(requestId = 'request-1', details: Partial<PromptPermissionDetails> = {}) {
      const { verdict, entries } = start(requestId, details)
      await vi.runAllTimersAsync()

      return { verdict: await verdict, entries }
    },
  }
}

describe('permission reviewer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
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
    // session key apart from the main conversation's.
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
    // Every reply is paid for, including the ones that were retried.
    expect(malformed.entries[0]?.[1]).toMatchObject({ errorCategory: 'invalid-response', inputTokens: 300 })

    // Request-time authentication fails inside the registry stream, so an unusable login arrives here too.
    const failing = createHarness({ replies: [new Error('no login'), new Error('no login'), new Error('no login')] })
    const exhausted = await failing.authorize()
    expect(exhausted.verdict).toEqual({ kind: 'defer' })
    expect(exhausted.entries[0]?.[1]).toMatchObject({ errorCategory: 'provider-error' })
    expect(failing.streamSimple).toHaveBeenCalledTimes(3)
  })

  // The authorizer chain does not isolate a link that throws.
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
    const harness = createHarness({
      config: { timeoutMs: 5 },
      respond: async options =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
    })
    const { verdict, entries } = await harness.authorize()

    expect(verdict).toEqual({ kind: 'defer' })
    expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'timeout' })
  })

  it('denies at once when the turn is interrupted, and spends no call on an ask raised after it', async () => {
    const turn = new AbortController()
    const harness = createHarness({
      turnSignal: turn.signal,
      respond: async () => {
        turn.abort()

        return new Promise(() => {})
      },
    })
    const { verdict, entries } = await harness.authorize()

    expect(verdict).toMatchObject({ kind: 'deny' })
    expect(entries[0]?.[1]).toMatchObject({ outcome: 'deny', errorCategory: 'cancelled' })

    expect((await harness.authorize('request-2')).verdict).toMatchObject({ kind: 'deny' })
    expect(harness.streamSimple).toHaveBeenCalledOnce()
  })

  describe('retries', () => {
    const failures = (count: number): Error[] => Array.from({ length: count }, () => new Error('temporary failure'))

    it('makes two retries 250 ms and 1 s apart by default, with provider retries off', async () => {
      const harness = createHarness({ replies: [...failures(3), reply(ALLOW)] })
      const { verdict, entries } = await harness.authorize()

      expect(verdict).toEqual({ kind: 'defer' })
      expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'provider-error' })
      expect(harness.callTimes).toEqual([0, 250, 1_250])
      expect(harness.callOptions().map(options => options.maxRetries)).toEqual([0, 0, 0])
    })

    it('retries maxRetries times, backing off to at most 30 s between calls', async () => {
      const harness = createHarness({
        config: { maxRetries: 7, timeoutMs: 300_000 },
        replies: [...failures(7), reply(ALLOW)],
      })
      const { verdict } = await harness.authorize()

      expect(verdict).toEqual({ kind: 'allow' })
      expect(harness.callTimes).toEqual([0, 250, 1_250, 5_250, 21_250, 51_250, 81_250, 111_250])
      expect(harness.callOptions().every(options => options.maxRetries === 0)).toBe(true)
    })

    it('makes a single call when maxRetries is 0', async () => {
      const harness = createHarness({ config: { maxRetries: 0 }, replies: [...failures(1), reply(ALLOW)] })
      const { verdict, entries } = await harness.authorize()

      expect(verdict).toEqual({ kind: 'defer' })
      expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'provider-error' })
      expect(harness.streamSimple).toHaveBeenCalledOnce()
    })

    it('pays for every malformed reply of a longer run, and defers once it is exhausted', async () => {
      const harness = createHarness({
        config: { maxRetries: 3 },
        replies: Array.from({ length: 5 }, () => reply('not json')),
      })
      const { verdict, entries } = await harness.authorize()

      expect(verdict).toEqual({ kind: 'defer' })
      expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'invalid-response', inputTokens: 400 })
      expect(harness.streamSimple).toHaveBeenCalledTimes(4)
    })

    it('never retries a valid denial', async () => {
      const harness = createHarness({ config: { maxRetries: 5 }, replies: [reply(DENY), reply(ALLOW)] })

      expect((await harness.authorize()).verdict).toMatchObject({ kind: 'deny' })
      expect(harness.streamSimple).toHaveBeenCalledOnce()
    })

    it('gives the call only the remaining review budget when no attempt timeout is set', async () => {
      const harness = createHarness({ replies: [...failures(1), reply(ALLOW)] })
      await harness.authorize()

      expect(harness.callOptions().map(options => options.timeoutMs)).toEqual([90_000, 89_750])
    })

    it('abandons an attempt at attemptTimeoutMs even if the provider ignores the abort, then retries', async () => {
      const harness = createHarness({ config: { attemptTimeoutMs: 1_000 }, replies: [HANG, reply(ALLOW)] })
      const { verdict } = await harness.authorize()
      const [first, second] = harness.callOptions()

      expect(verdict).toEqual({ kind: 'allow' })
      expect(harness.callTimes).toEqual([0, 1_250])
      expect(first).toMatchObject({ timeoutMs: 1_000 })
      expect(first?.signal?.aborted).toBe(true)
      expect(second?.signal?.aborted).toBe(false)
    })

    it('discards the late reply of an abandoned attempt', async () => {
      const harness = createHarness({
        config: { attemptTimeoutMs: 1_000 },
        replies: [later(1_100, reply(DENY)), reply(ALLOW)],
      })
      const { verdict, entries } = await harness.authorize()

      expect(verdict).toEqual({ kind: 'allow' })
      expect(entries[0]?.[1]).toMatchObject({ outcome: 'allow', inputTokens: 100 })
    })

    it('defers with attempt-timeout once every attempt has timed out, leaving no timer behind', async () => {
      const harness = createHarness({ config: { maxRetries: 1, attemptTimeoutMs: 1_000 }, replies: [HANG, HANG] })
      const { verdict, entries } = harness.start()
      await vi.advanceTimersByTimeAsync(2_249)
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      await vi.advanceTimersByTimeAsync(1)

      expect(await verdict).toEqual({ kind: 'defer' })
      expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'attempt-timeout', durationMs: 2_250 })
      expect(harness.callTimes).toEqual([0, 1_250])
      expect(vi.getTimerCount()).toBe(0)
    })

    it('leaves no timer behind once the last attempt fails', async () => {
      const harness = createHarness({ config: { maxRetries: 1, attemptTimeoutMs: 60_000 }, replies: failures(2) })
      const { verdict, entries } = harness.start()
      await vi.advanceTimersByTimeAsync(249)
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      await vi.advanceTimersByTimeAsync(1)

      expect(await verdict).toEqual({ kind: 'defer' })
      expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'provider-error' })
      expect(harness.streamSimple).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('caps a call at the remaining review budget when the attempt timeout is longer', async () => {
      const harness = createHarness({
        config: { timeoutMs: 2_000, attemptTimeoutMs: 60_000 },
        replies: [...failures(1), HANG],
      })
      const { verdict, entries } = await harness.authorize()

      expect(verdict).toEqual({ kind: 'defer' })
      expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'timeout', durationMs: 2_000 })
      expect(harness.callOptions().map(options => options.timeoutMs)).toEqual([2_000, 1_750])
    })

    it('reports the review timeout when it expires together with the attempt timeout', async () => {
      const harness = createHarness({
        config: { timeoutMs: 1_000, attemptTimeoutMs: 1_000 },
        replies: [HANG, reply(ALLOW)],
      })
      const { verdict, entries } = await harness.authorize()

      expect(verdict).toEqual({ kind: 'defer' })
      expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'timeout' })
      expect(harness.streamSimple).toHaveBeenCalledOnce()
    })

    it('ends a backoff at the review deadline instead of sleeping past it', async () => {
      const harness = createHarness({
        config: { timeoutMs: 1_000, maxRetries: 5 },
        replies: [...failures(2), reply(ALLOW)],
      })
      const { verdict, entries } = await harness.authorize()

      expect(verdict).toEqual({ kind: 'defer' })
      expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'timeout', durationMs: 1_000 })
      expect(harness.callTimes).toEqual([0, 250])
    })

    it('makes no call when a backoff ends exactly at the review deadline', async () => {
      const harness = createHarness({
        config: { timeoutMs: 1_250, maxRetries: 5 },
        replies: [...failures(2), reply(ALLOW)],
      })
      const { verdict, entries } = await harness.authorize()

      expect(verdict).toEqual({ kind: 'defer' })
      expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'timeout', durationMs: 1_250 })
      expect(harness.callTimes).toEqual([0, 250])
    })

    it('makes no call once prompt setup has used up the review budget', async () => {
      const harness = createHarness({
        getProvider: () => {
          vi.setSystemTime(Date.now() + 90_000)

          return { id: 'custom-review' }
        },
      })
      const { verdict, entries } = await harness.authorize()

      expect(verdict).toEqual({ kind: 'defer' })
      expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'timeout' })
      expect(harness.streamSimple).not.toHaveBeenCalled()
    })

    it('denies when the turn is interrupted during a backoff, without another call', async () => {
      const turn = new AbortController()
      const harness = createHarness({ turnSignal: turn.signal, replies: [...failures(1), reply(ALLOW)] })
      const { verdict, entries } = harness.start()
      await vi.advanceTimersByTimeAsync(100)
      turn.abort()

      expect(await verdict).toMatchObject({ kind: 'deny' })
      expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'cancelled', durationMs: 100 })
      expect(harness.streamSimple).toHaveBeenCalledOnce()
    })

    it('denies when the session ends during an attempt the provider would not abort', async () => {
      const session = new AbortController()
      const harness = createHarness({
        sessionSignal: session.signal,
        config: { attemptTimeoutMs: 1_000 },
        replies: [HANG, reply(ALLOW)],
      })
      const { verdict, entries } = harness.start()
      await vi.advanceTimersByTimeAsync(500)
      session.abort()

      expect(await verdict).toMatchObject({ kind: 'deny' })
      expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'cancelled', durationMs: 500 })
      expect(harness.streamSimple).toHaveBeenCalledOnce()
    })

    it('denies when the turn is interrupted during the only permitted call, leaving no timer behind', async () => {
      const turn = new AbortController()
      const harness = createHarness({
        turnSignal: turn.signal,
        config: { maxRetries: 0, attemptTimeoutMs: 60_000 },
        replies: [HANG],
      })
      const { verdict, entries } = harness.start()
      await vi.advanceTimersByTimeAsync(500)
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      turn.abort()

      expect(await verdict).toMatchObject({ kind: 'deny' })
      expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'cancelled', durationMs: 500 })
      expect(vi.getTimerCount()).toBe(0)
    })

    it('defers with timeout when the review deadline passes during the only permitted call', async () => {
      const harness = createHarness({
        config: { maxRetries: 0, timeoutMs: 1_000, attemptTimeoutMs: 60_000 },
        replies: [HANG],
      })
      const { verdict, entries } = harness.start()
      await vi.advanceTimersByTimeAsync(999)
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      await vi.advanceTimersByTimeAsync(1)

      expect(await verdict).toEqual({ kind: 'defer' })
      expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'timeout', durationMs: 1_000 })
      expect(vi.getTimerCount()).toBe(0)
    })

    it('leaves no timer behind once a review with an attempt timeout settles', async () => {
      const harness = createHarness({ config: { attemptTimeoutMs: 60_000 }, replies: [...failures(1), reply(ALLOW)] })
      const { verdict } = harness.start()
      await vi.advanceTimersByTimeAsync(250)

      expect(await verdict).toEqual({ kind: 'allow' })
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})
