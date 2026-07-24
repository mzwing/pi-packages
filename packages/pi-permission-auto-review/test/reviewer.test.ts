import type { ReviewModelRegistry } from '../src/model.js'
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  Provider,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { AuthorizerLog, PermissionQuery, PromptPermissionDetails } from '@gotgenes/pi-permission-system'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DenialCircuitBreaker } from '../src/circuit-breaker.js'
import { autoReviewConfigSchema } from '../src/config.js'
import { createPermissionReviewer } from '../src/reviewer.js'

function createModel(): Model<Api> {
  return {
    id: 'review-model',
    name: 'Review Model',
    api: 'openai-responses',
    provider: 'custom-review',
    baseUrl: 'https://review.example/v1',
    reasoning: true,
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 16_000,
  }
}

function assistantMessage(text: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-responses',
    provider: 'custom-review',
    model: 'review-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason,
    timestamp: 0,
  }
}

function streamFrom(result: () => Promise<AssistantMessage>): AssistantMessageEventStream {
  return { result } as AssistantMessageEventStream
}

function userEntry(): SessionEntry {
  return {
    type: 'message',
    id: 'user-1',
    parentId: null,
    timestamp: '2026-07-23T00:00:00.000Z',
    message: {
      role: 'user',
      content: 'Please run the requested operation.',
      timestamp: 0,
    },
  }
}

function details(overrides: Partial<PromptPermissionDetails> = {}): PromptPermissionDetails {
  return {
    requestId: 'request-1',
    source: 'tool_call',
    agentName: null,
    message: 'Run command',
    toolName: 'bash',
    command: 'pnpm publish',
    surface: 'bash',
    ...overrides,
  }
}

interface TestLog extends AuthorizerLog {
  review: ReturnType<typeof vi.fn<AuthorizerLog['review']>>
  debug: ReturnType<typeof vi.fn<AuthorizerLog['debug']>>
}

function createLog(): TestLog {
  return {
    review: vi.fn<AuthorizerLog['review']>(),
    debug: vi.fn<AuthorizerLog['debug']>(),
  }
}

interface HarnessOptions {
  responses?: Array<AssistantMessage | Error>
  auth?: Awaited<ReturnType<ReviewModelRegistry['getApiKeyAndHeaders']>>
  timeoutMs?: number
  resultFactory?: (options: SimpleStreamOptions) => Promise<AssistantMessage>
}

function createHarness(options: HarnessOptions = {}) {
  const model = createModel()
  const responses = [...(options.responses ?? [assistantMessage('{"outcome":"allow"}')])]
  const streamSimple = vi.fn((_model: Model<Api>, _context: unknown, streamOptions: SimpleStreamOptions = {}) =>
    streamFrom(async () => {
      if (options.resultFactory !== undefined) {
        return options.resultFactory(streamOptions)
      }
      const next = responses.shift()
      if (next instanceof Error) {
        throw next
      }
      if (next === undefined) {
        throw new Error('no fake response')
      }
      return next
    }),
  )
  const provider = {
    id: 'custom-review',
    name: 'Custom Review',
    auth: {},
    getModels: () => [model],
    stream: streamSimple,
    streamSimple,
  } as unknown as Provider
  const getApiKeyAndHeaders = vi.fn(async () =>
    Promise.resolve(
      options.auth ?? {
        ok: true as const,
        apiKey: 'secret-key',
        headers: { 'x-review': 'enabled' },
        env: { REVIEW_REGION: 'test' },
      },
    ),
  )
  const registry: ReviewModelRegistry = {
    find: vi.fn(() => model),
    getAll: vi.fn(() => [model]),
    getProvider: vi.fn(() => provider),
    getApiKeyAndHeaders,
  }
  const circuitBreaker = new DenialCircuitBreaker()
  const authorize = createPermissionReviewer(
    {
      config: autoReviewConfigSchema.parse({
        provider: 'custom-review',
        model: 'review-model',
        timeoutMs: options.timeoutMs ?? 90_000,
      }),
      registry,
      sessionManager: {
        buildContextEntries: () => [userEntry()],
      },
      circuitBreaker,
    },
    {
      now: () => 0,
      retryDelaysMs: [0, 0],
      sleep: async () => Promise.resolve(),
    },
  )

  return {
    authorize,
    circuitBreaker,
    getApiKeyAndHeaders,
    streamSimple,
  }
}

const query = {} as PermissionQuery

describe('permission reviewer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('passes Pi-managed auth to a tool-free provider call and allows', async () => {
    const harness = createHarness()
    const log = createLog()

    await expect(harness.authorize(details(), query, log)).resolves.toEqual({
      kind: 'allow',
    })

    expect(harness.getApiKeyAndHeaders.mock.calls).toHaveLength(1)
    const [, context, options] = harness.streamSimple.mock.calls[0] ?? []
    expect(context).toMatchObject({
      messages: [{ role: 'user' }],
    })
    expect(context).not.toHaveProperty('tools')
    expect((context as { systemPrompt?: string }).systemPrompt).toContain(
      'Only transcript JSONL records whose source field is "user"',
    )
    expect(options).toMatchObject({
      apiKey: 'secret-key',
      headers: { 'x-review': 'enabled' },
      env: { REVIEW_REGION: 'test' },
      maxRetries: 0,
      maxTokens: 1_000,
      reasoning: 'low',
    })
  })

  it('returns a teaching denial without persisting the rationale', async () => {
    const harness = createHarness({
      responses: [
        assistantMessage(
          '{"risk_level":"high","user_authorization":"unknown","outcome":"deny","rationale":"Publishing was not authorized."}',
        ),
      ],
    })
    const log = createLog()

    const result = await harness.authorize(details({ surface: 'path', path: '.env' }), query, log)

    expect(result.kind).toBe('deny')
    if (result.kind === 'deny') {
      expect(result.reason).toContain('Publishing was not authorized.')
    }
    expect(log.review.mock.calls[0]?.[0]).toBe('auto_review.decision')
    expect(log.review.mock.calls[0]?.[1]).toMatchObject({
      outcome: 'deny',
      riskLevel: 'high',
      userAuthorization: 'unknown',
    })
    expect(log.review.mock.calls[0]?.[1]).not.toHaveProperty('rationale')
    expect(log.review.mock.calls[0]?.[1]).not.toHaveProperty('surface')
  })

  it('retries transient provider failures within the same review', async () => {
    const harness = createHarness({
      responses: [
        new Error('temporary failure'),
        assistantMessage('', 'error'),
        assistantMessage('{"outcome":"allow"}'),
      ],
    })

    await expect(harness.authorize(details(), query, createLog())).resolves.toEqual({ kind: 'allow' })
    expect(harness.streamSimple.mock.calls).toHaveLength(3)
  })

  it('defers malformed output and missing auth to the human authorizer', async () => {
    const malformed = createHarness({
      responses: [assistantMessage('not json')],
    })
    const malformedLog = createLog()
    await expect(malformed.authorize(details(), query, malformedLog)).resolves.toEqual({ kind: 'defer' })
    expect(malformedLog.review.mock.calls[0]?.[0]).toBe('auto_review.decision')
    expect(malformedLog.review.mock.calls[0]?.[1]).toMatchObject({
      errorCategory: 'invalid-response',
    })

    const missingAuth = createHarness({
      auth: { ok: false, error: 'not configured' },
    })
    await expect(missingAuth.authorize(details(), query, createLog())).resolves.toEqual({ kind: 'defer' })
    expect(missingAuth.streamSimple.mock.calls).toHaveLength(0)
  })

  it('opens the per-turn circuit after three consecutive denials', async () => {
    const denial = assistantMessage('{"outcome":"deny","rationale":"Not authorized."}')
    const harness = createHarness({
      responses: [denial, denial, denial],
    })

    for (let index = 0; index < 3; index += 1) {
      await expect(
        harness.authorize(details({ requestId: `request-${index}` }), query, createLog()),
      ).resolves.toMatchObject({ kind: 'deny' })
    }

    const circuitLog = createLog()
    const circuitResult = await harness.authorize(details({ requestId: 'request-4' }), query, circuitLog)
    expect(circuitResult.kind).toBe('deny')
    if (circuitResult.kind === 'deny') {
      expect(circuitResult.reason).toContain('explicit approval')
    }
    expect(harness.streamSimple.mock.calls).toHaveLength(3)
    expect(circuitLog.review.mock.calls[0]?.[0]).toBe('auto_review.circuit_open')
  })

  it('opens the per-turn circuit after ten non-consecutive denials in the recent window', async () => {
    const denial = assistantMessage('{"outcome":"deny","rationale":"Not authorized."}')
    const allow = assistantMessage('{"outcome":"allow"}')
    const responses = Array.from({ length: 10 }, () => [denial, allow]).flat()
    const harness = createHarness({ responses })

    for (let index = 0; index < 19; index += 1) {
      await harness.authorize(details({ requestId: `request-${index}` }), query, createLog())
    }

    await expect(
      harness.authorize(details({ requestId: 'request-circuit' }), query, createLog()),
    ).resolves.toMatchObject({ kind: 'deny' })
    expect(harness.streamSimple.mock.calls).toHaveLength(19)

    harness.circuitBreaker.resetTurn()
    await expect(harness.authorize(details({ requestId: 'request-new-turn' }), query, createLog())).resolves.toEqual({
      kind: 'allow',
    })
    expect(harness.streamSimple.mock.calls).toHaveLength(20)
  })

  it('aborts at the total timeout and defers', async () => {
    vi.useFakeTimers()
    const harness = createHarness({
      timeoutMs: 5,
      resultFactory: async streamOptions =>
        new Promise((_resolve, reject) => {
          streamOptions.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
    })
    const log = createLog()

    const result = harness.authorize(details(), query, log)
    await vi.advanceTimersByTimeAsync(10)

    await expect(result).resolves.toEqual({ kind: 'defer' })
    expect(log.review.mock.calls[0]?.[0]).toBe('auto_review.decision')
    expect(log.review.mock.calls[0]?.[1]).toMatchObject({
      errorCategory: 'timeout',
    })
  })
})
