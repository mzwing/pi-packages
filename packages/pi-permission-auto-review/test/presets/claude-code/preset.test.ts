import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POLICY_REVISION } from '../../../src/presets/claude-code/policy.js'
import { createReviewerHarness, reply, toolCallEntry, USER_ENTRY } from '../../helpers.js'

const ALLOW = '<block>no</block>'
const BLOCK = '<block>yes</block>'
const DENY =
  '<thinking>The push rewrites main.</thinking><block>yes</block><category>Git Destructive</category><reason>[Git Destructive] Force-pushing main destroys shared history.</reason>'
const CLEAR = '<thinking>The user named this exact push.</thinking><block>no</block>'

type HarnessOptions = Partial<Parameters<typeof createReviewerHarness>[0]>

function createHarness(options: HarnessOptions = {}): ReturnType<typeof createReviewerHarness> {
  return createReviewerHarness({
    replies: [reply(ALLOW)],
    ...options,
    config: { preset: 'claude-code', ...options.config },
  })
}

function siblingCalls(): SessionEntry {
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: [
      { type: 'toolCall', id: 'call-1', name: 'write', arguments: { path: 'a.md', content: 'first' } },
      { type: 'toolCall', id: 'call-2', name: 'write', arguments: { path: 'b.md', content: 'second' } },
      { type: 'toolCall', id: 'call-3', name: 'write', arguments: { path: 'c.md', content: 'third' } },
    ],
    timestamp: 0,
  }

  return {
    type: 'message',
    id: 'assistant-siblings',
    parentId: 'user-1',
    timestamp: '2026-07-23T00:00:00.000Z',
    message,
  } as SessionEntry
}

describe('claude-code preset', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('allows on a fast pass, in one call that asks for no reasoning', async () => {
    const harness = createHarness()
    const { verdict, entries } = await harness.authorize()
    const [, context, options] = harness.streamSimple.mock.calls[0] ?? []

    expect(verdict).toEqual({ kind: 'allow' })
    expect(harness.streamSimple).toHaveBeenCalledOnce()
    expect(context?.messages[0]?.content).toMatch(/^<transcript>\n[\s\S]*\n<\/transcript>\n\nFast pass:/)
    expect(options).toMatchObject({ maxTokens: 1024 })
    expect(options).not.toHaveProperty('reasoning')
    expect(entries[0]?.[1]).toMatchObject({ outcome: 'allow', stage: 'fast', policyRevision: POLICY_REVISION })
  })

  it('sends a fast block to a second pass that continues it, and denies with the rule and guidance', async () => {
    const fast = reply(BLOCK)
    const harness = createHarness({ replies: [fast, reply(DENY)], config: { reasoning: 'low' } })
    const { verdict, entries } = await harness.authorize()
    const [, first] = harness.streamSimple.mock.calls[0] ?? []
    const [, second, secondOptions] = harness.streamSimple.mock.calls[1] ?? []

    expect(second?.messages.slice(0, 2)).toEqual([first?.messages[0], fast])
    expect(second?.messages[2]?.content).toMatch(/^Second pass\./)
    expect(secondOptions).toMatchObject({ reasoning: 'low' })
    expect(secondOptions).not.toHaveProperty('maxTokens')
    expect(verdict.kind === 'deny' ? verdict.reason : undefined).toMatch(
      /^\[Git Destructive\] Force-pushing main destroys shared history\. Do not reach the same result another way/,
    )
    expect(entries[0]?.[1]).toMatchObject({
      outcome: 'deny',
      stage: 'thinking',
      fastVerdict: 'block',
      category: 'Git Destructive',
      usage: { input: 200, cacheRead: 80, output: 20 },
    })
  })

  it('escalates a fast reply that opens without a verdict, without retrying it, and lets the second pass clear it', async () => {
    const harness = createHarness({ replies: [reply('Looking at the push first.'), reply(CLEAR)] })
    const { verdict, entries } = await harness.authorize()

    expect(verdict).toEqual({ kind: 'allow' })
    expect(harness.streamSimple).toHaveBeenCalledTimes(2)
    expect(entries[0]?.[1]).toMatchObject({ outcome: 'allow', stage: 'thinking', fastVerdict: 'unparseable' })
  })

  it('retries a second pass without a verdict, then defers to the human prompt', async () => {
    const harness = createHarness({
      replies: [reply(BLOCK), reply('<thinking>Unsure'), reply('No verdict.'), reply('<block>maybe</block>')],
    })
    const { verdict, entries } = await harness.authorize()

    expect(verdict).toEqual({ kind: 'defer' })
    expect(harness.streamSimple).toHaveBeenCalledTimes(4)
    expect(entries[0]?.[1]).toMatchObject({ errorCategory: 'invalid-response', stage: 'thinking' })
  })

  it('hands the third denial in a row to the human prompt, then counts afresh', async () => {
    const harness = createHarness({ replies: Array.from({ length: 4 }, () => [reply(BLOCK), reply(DENY)]).flat() })
    const results = []
    for (let index = 1; index <= 4; index += 1) {
      results.push(await harness.authorize(`request-${index}`))
    }

    expect(results.map(({ verdict }) => verdict.kind)).toEqual(['deny', 'deny', 'defer', 'deny'])
    expect(results[2]?.entries[0]?.[1]).toMatchObject({ outcome: 'defer', denialLimit: 'consecutive' })
  })

  describe('follow-up reviews', () => {
    it('continues the conversation with only the lines the session added, ending with the next action', async () => {
      const first = reply(ALLOW)
      const harness = createHarness({
        entries: [USER_ENTRY, toolCallEntry({ path: 'a.md', content: 'first' })],
        replies: [first, reply(ALLOW)],
      })
      await harness.authorize('request-1', { toolCallId: 'call-1' })
      harness.branch.push(toolCallEntry({ path: 'b.md', content: 'the second change' }, 'call-2'))
      const { entries } = await harness.authorize('request-2', { toolCallId: 'call-2' })
      const [, initial] = harness.streamSimple.mock.calls[0] ?? []
      const [, followUp] = harness.streamSimple.mock.calls[1] ?? []

      expect(followUp?.messages.slice(0, 2)).toEqual([initial?.messages[0], first])
      expect(followUp?.messages[2]?.content).toMatch(
        /^<transcript_delta>\n\{"write":\{"path":"b\.md","content":"the second change"\},"id":"2\.0"\}\n<\/transcript_delta>/,
      )
      expect(entries[0]?.[1]).toMatchObject({ priorReviews: 1 })
    })

    // Pi gates sibling calls one after another before running any of them; the middle one raised no ask
    it('sends a later sibling with only the siblings between it and the one reviewed before', async () => {
      const harness = createHarness({ entries: [USER_ENTRY, siblingCalls()], replies: [reply(ALLOW), reply(ALLOW)] })
      await harness.authorize('request-1', { toolCallId: 'call-1' })
      await harness.authorize('request-2', { toolCallId: 'call-3' })
      const [, initial] = harness.streamSimple.mock.calls[0] ?? []
      const [, followUp] = harness.streamSimple.mock.calls[1] ?? []

      expect(initial?.messages[0]?.content).not.toMatch(/b\.md|c\.md/)
      expect(followUp?.messages[2]?.content).toMatch(
        /^<transcript_delta>\n\{"write":\{"path":"b\.md","content":"second"\},"id":"1\.1"\}\n\{"write":\{"path":"c\.md","content":"third"\},"id":"1\.2"\}\n<\/transcript_delta>/,
      )
    })
  })
})
