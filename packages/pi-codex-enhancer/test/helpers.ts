import type { StatusTheme } from '../src/render.js'
import type { Ticket } from '../src/state.js'
import type { TicketFileSystem } from '../src/store.js'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ModelRegistry } from '@earendil-works/pi-coding-agent'
import { Buffer } from 'node:buffer'

export const PLAIN_THEME: StatusTheme = { fg: (_color, text) => text }

export function goodState(): string {
  return `gAAAAA${'x'.repeat(286)}`
}

export function degradedState(): string {
  return `gAAAAA${'x'.repeat(306)}`
}

export function probeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    accountId: 'acct-1',
    model: 'gpt-6-astra',
    value: goodState(),
    capturedAt: 0,
    source: 'probe',
    ...overrides,
  }
}

export function makeToken(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
    'utf8',
  ).toString('base64url')

  return `header.${payload}.signature`
}

export function codexModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: 'gpt-6-astra',
    name: 'GPT-6 Astra',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: 'https://chatgpt.com/backend-api',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400_000,
    maxTokens: 128_000,
    ...overrides,
  }
}

export interface RegistryAuth {
  ok: boolean
  apiKey?: string | undefined
  headers?: Record<string, string | null> | undefined
  baseUrl?: string | undefined
  error?: string | undefined
}

export function createRegistry(auth: RegistryAuth = { ok: true, apiKey: makeToken('acct-1') }): ModelRegistry {
  return {
    getAll: () => [],
    find: () => undefined,
    getApiKeyAndHeaders: async () => auth,
  } as unknown as ModelRegistry
}

interface CommandRegistration {
  description?: string
  getArgumentCompletions?: (prefix: string) => unknown
  handler: (args: string, ctx: unknown) => Promise<void>
}

interface UiRecorder {
  statuses: (string | undefined)[]
  notifications: { message: string; type: string | undefined }[]
}

interface HarnessContext {
  ui: {
    setStatus: (key: string, text: string | undefined) => void
    notify: (message: string, type?: string) => void
    theme: StatusTheme
  }
  cwd: string
  modelRegistry: ModelRegistry
  model: Model<Api> | undefined
  signal: AbortSignal | undefined
}

export interface Harness {
  pi: ExtensionAPI
  commands: Map<string, CommandRegistration>
  ui: UiRecorder
  context: HarnessContext
  emit: (event: string, payload: unknown) => Promise<void>
}

export function createHarness(registry: ModelRegistry = createRegistry()): Harness {
  const handlers = new Map<string, ((event: unknown, context: unknown) => unknown)[]>()
  const commands = new Map<string, CommandRegistration>()
  const ui: UiRecorder = { statuses: [], notifications: [] }

  const context: HarnessContext = {
    ui: {
      setStatus: (_key, text) => ui.statuses.push(text),
      notify: (message, type) => ui.notifications.push({ message, type }),
      theme: PLAIN_THEME,
    },
    cwd: '/workspace',
    modelRegistry: registry,
    model: codexModel(),
    signal: undefined,
  }

  const pi = {
    on(event: string, handler: (event: unknown, context: unknown) => unknown) {
      const bucket = handlers.get(event) ?? []
      bucket.push(handler)
      handlers.set(event, bucket)
    },
    registerCommand(name: string, options: CommandRegistration) {
      commands.set(name, options)
    },
    events: { on: () => () => {}, emit: () => {} },
  }

  return {
    pi: pi as unknown as ExtensionAPI,
    commands,
    ui,
    context,
    async emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) {
        await handler(payload, context)
      }
    },
  }
}

export interface MemoryFileSystem extends TicketFileSystem {
  files: Map<string, string>
}

export function createMemoryFileSystem(seed: Record<string, string> = {}): MemoryFileSystem {
  const files = new Map<string, string>(Object.entries(seed))

  return {
    files,
    readFile: path => files.get(path),
    writeFile: (path, data) => {
      files.set(path, data)
    },
    rename: (from, to) => {
      const data = files.get(from)
      if (data === undefined) {
        throw new Error(`no such file: ${from}`)
      }
      files.set(to, data)
      files.delete(from)
    },
    mkdir: () => {},
    unlink: path => {
      files.delete(path)
    },
  }
}
