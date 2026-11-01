import type { AssistantMessage } from '@earendil-works/pi-ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POLICY_REVISION } from '../../src/presets/codex/policy.js'
import { createReviewerHarness, reply, STALLED_REPLY, toolCallEntry, USER_ENTRY } from '../helpers.js'

const ALLOW = '{"outcome":"allow"}'
const DENY =
  '{"risk_level":"high","user_authorization":"unknown","outcome":"deny","rationale":"Publishing was not authorized."}'

function createHarness(options: Partial<Parameters<typeof createReviewerHarness>[0]> = {}) {
  return createReviewerHarness({ replies: [reply(ALLOW)], ...options })
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
      usage: { input: 100, cacheRead: 40, output: 10 },
    })
  })

  it('returns a denial that teaches and forbids workarounds, without writing the rationale to the log', async () => {
    const { verdict, entries } = await createHarness({ replies: [reply(DENY)] }).authorize()

    expect(verdict.kind === 'deny' ? verdict.reason : undefined).toMatch(
      /^Publishing was not authorized\. \(risk: high, user authorization: unknown\)\. The agent must not attempt to achieve the same outcome via workaround/,
    )
    expect(entries[0]?.[1]).toMatchObject({ outcome: 'deny', riskLevel: 'high', userApproval: 'unknown' })
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
    expect(malformed.entries[0]?.[1]).toMatchObject({ errorCategory: 'invalid-response', usage: { input: 300 } })

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

    harness.resetTurn()
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

  describe('follow-up reviews', () => {
    const uncached = (): AssistantMessage => reply(ALLOW, 'stop', { cacheRead: 0 })
    const messageCounts = (harness: ReturnType<typeof createHarness>): number[] =>
      harness.streamSimple.mock.calls.map(([, context]) => context.messages.length)

    async function authorizeEach(harness: ReturnType<typeof createHarness>, count: number): Promise<void> {
      for (let index = 1; index <= count; index += 1) {
        await harness.authorize(`request-${index}`)
      }
    }

    it('continues the conversation with only what the session added since the last review', async () => {
      const first = reply(ALLOW)
      const harness = createHarness({ replies: [first, reply(ALLOW)] })
      await harness.authorize('request-1')
      harness.branch.push(toolCallEntry({ path: 'notes.md', content: 'the second change' }))
      const { entries } = await harness.authorize('request-2')
      const [, initial] = harness.streamSimple.mock.calls[0] ?? []
      const [, followUp] = harness.streamSimple.mock.calls[1] ?? []

      expect(followUp?.systemPrompt).toBe(initial?.systemPrompt)
      expect(followUp?.messages.slice(0, 2)).toEqual([initial?.messages[0], first])
      expect(followUp?.messages[2]?.content).toContain('>>> TRANSCRIPT DELTA JSONL START')
      expect(followUp?.messages[2]?.content).toContain('the second change')
      expect(followUp?.messages[2]?.content).not.toContain('Please run the requested operation.')
      expect(entries[0]?.[1]).toMatchObject({ priorReviews: 1 })
    })

    it('starts over in full once the reviewed entries leave the branch, or the conversation would not fit', async () => {
      const moved = createHarness({ replies: [reply(ALLOW), reply(ALLOW)] })
      await moved.authorize('request-1')
      moved.branch.splice(0, 1, { ...USER_ENTRY, id: 'user-2' })
      await moved.authorize('request-2')

      const crowded = createHarness({ replies: [reply(ALLOW, 'stop', { totalTokens: 190_000 }), reply(ALLOW)] })
      await authorizeEach(crowded, 2)

      // Every review rereads the whole conversation, so a large window does not let it grow past 256k tokens
      const capped = createHarness({
        contextWindow: 1_000_000,
        replies: [reply(ALLOW, 'stop', { totalTokens: 250_000 }), reply(ALLOW)],
      })
      await authorizeEach(capped, 2)

      expect(messageCounts(moved)).toEqual([1, 1])
      expect(messageCounts(crowded)).toEqual([1, 1])
      expect(messageCounts(capped)).toEqual([1, 1])
    })

    it('starts over after a follow-up the provider served without a cache hit, unless told to always follow up', async () => {
      const modes = [
        ['auto', [1, 3, 1]],
        ['always', [1, 3, 5]],
        ['off', [1, 1, 1]],
      ] as const
      for (const [followUpReviews, counts] of modes) {
        const harness = createHarness({ config: { followUpReviews }, replies: [uncached(), uncached(), uncached()] })
        await authorizeEach(harness, 3)

        expect(messageCounts(harness)).toEqual(counts)
      }
    })

    it('starts over after a review that failed', async () => {
      const harness = createHarness({
        config: { maxRetries: 0 },
        replies: [reply(ALLOW), new Error('context length exceeded'), reply(ALLOW)],
      })
      await authorizeEach(harness, 3)

      expect(messageCounts(harness)).toEqual([1, 3, 1])
    })
  })
})
