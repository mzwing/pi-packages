import type { AutoReviewConfig } from '../src/config/config.js'
import type { AssistantMessage, Context, SimpleStreamOptions, Usage } from '@earendil-works/pi-ai'
import type { ModelRegistry, SessionEntry } from '@earendil-works/pi-coding-agent'
import type {
  AuthorizerLog,
  AuthorizerVerdict,
  PermissionQuery,
  PromptPermissionDetails,
} from '@gotgenes/pi-permission-system'
import type { Mock } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import { mergeConfig } from '../src/config/config.js'
import { createPermissionReviewer } from '../src/reviewer/reviewer.js'

/** A throwaway project and agent dir, with `PI_CODING_AGENT_DIR` pointed at the latter */
export function useWorkspace(): { cwd: string } {
  const workspace = { cwd: '' }
  let root = ''
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pi-permission-auto-review-'))
    workspace.cwd = join(root, 'project')
    vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'agent'))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  return workspace
}

export function writeFile(path: string, contents: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents))
}

export function permissionDetails(overrides: Partial<PromptPermissionDetails> = {}): PromptPermissionDetails {
  return {
    requestId: 'request-1',
    source: 'tool_call',
    agentName: null,
    payload: {
      kind: 'bash',
      request: {
        requester: { agentName: null, forwarded: false, sessionId: null },
        surface: 'bash',
        toolName: 'bash',
        invokedToolName: null,
        value: 'pnpm publish',
        matchedPattern: 'pnpm publish*',
        matchedSpelling: null,
        commandContext: null,
        executedUnit: null,
        decidingPath: null,
      },
      evidence: [{ label: 'command', text: 'pnpm publish', detail: null }],
      annotations: [],
    },
    toolName: 'bash',
    command: 'pnpm publish',
    surface: 'bash',
    ...overrides,
  }
}

export const STALLED_REPLY: Promise<AssistantMessage> = new Promise(() => {})

export const USER_ENTRY: SessionEntry = {
  type: 'message',
  id: 'user-1',
  parentId: null,
  timestamp: '2026-07-23T00:00:00.000Z',
  message: { role: 'user', content: 'Please run the requested operation.', timestamp: 0 },
}

export function reply(
  text: string,
  stopReason: AssistantMessage['stopReason'] = 'stop',
  usage: Partial<Usage> = {},
): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason,
    usage: { input: 100, output: 10, cacheRead: 40, cacheWrite: 0, totalTokens: 150, ...usage },
  } as AssistantMessage
}

export function toolCallEntry(input: Record<string, unknown>, callId = 'call-1'): SessionEntry {
  return {
    type: 'message',
    id: `assistant-${callId}`,
    parentId: 'user-1',
    timestamp: '2026-07-23T00:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: callId, name: 'write', arguments: input }],
      timestamp: 0,
    },
  } as SessionEntry
}

type StreamSimple = (
  model: unknown,
  context: Required<Pick<Context, 'systemPrompt' | 'messages'>>,
  options: SimpleStreamOptions,
) => { result: () => Promise<AssistantMessage> }

type ReviewStart = (
  requestId?: string,
  details?: Partial<PromptPermissionDetails>,
) => { verdict: Promise<AuthorizerVerdict>; entries: Parameters<AuthorizerLog['review']>[] }

interface ReviewerHarness {
  /** The session's active branch, which a test may grow or replace between reviews */
  branch: SessionEntry[]
  resetTurn: () => void
  streamSimple: Mock<StreamSimple>
  callTimes: number[]
  start: ReviewStart
  /** Runs the retry delays and the review timeout on the fake clock */
  authorize: (
    requestId?: string,
    details?: Partial<PromptPermissionDetails>,
  ) => Promise<{ verdict: AuthorizerVerdict; entries: Parameters<AuthorizerLog['review']>[] }>
}

interface ReviewerHarnessOptions {
  /** Every reply the model gives, in order */
  replies: (AssistantMessage | Error | Promise<AssistantMessage>)[]
  config?: Partial<AutoReviewConfig>
  getProvider?: () => unknown
  entries?: SessionEntry[]
  turnSignal?: AbortSignal
  contextWindow?: number
}

export function createReviewerHarness(options: ReviewerHarnessOptions): ReviewerHarness {
  const replies = [...options.replies]
  const callTimes: number[] = []
  const branch = [...(options.entries ?? [USER_ENTRY])]
  const streamSimple = vi.fn<StreamSimple>(() => ({
    result: async () => {
      callTimes.push(Date.now())
      const next = replies.shift() ?? new Error('no scripted reply')
      if (next instanceof Error) {
        throw next
      }

      return next
    },
  }))
  const model = {
    id: 'review-model',
    provider: 'custom-review',
    api: 'openai-responses',
    reasoning: true,
    contextWindow: options.contextWindow ?? 200_000,
  }
  const registry = {
    find: () => model,
    getProvider: options.getProvider ?? (() => ({ id: 'custom-review' })),
    streamSimple,
  } as unknown as ModelRegistry
  const reviewer = createPermissionReviewer({
    config: mergeConfig({}, { provider: 'custom-review', model: 'review-model', ...options.config }),
    context: {
      modelRegistry: registry,
      sessionManager: { getBranch: () => [...branch], getSessionId: () => 'session-1' },
      signal: options.turnSignal,
    } as never,
    contextFiles: () => [],
    sessionSignal: new AbortController().signal,
  })

  const start: ReviewStart = (requestId = 'request-1', details = {}) => {
    const review = vi.fn<AuthorizerLog['review']>()
    const verdict = reviewer.authorize(permissionDetails({ requestId, ...details }), {} as PermissionQuery, {
      review,
      debug: vi.fn(),
    })

    return { verdict, entries: review.mock.calls }
  }

  return {
    branch,
    resetTurn: reviewer.resetTurn,
    streamSimple,
    callTimes,
    start,
    async authorize(requestId = 'request-1', details = {}) {
      const { verdict, entries } = start(requestId, details)
      await vi.runAllTimersAsync()

      return { verdict: await verdict, entries }
    },
  }
}
