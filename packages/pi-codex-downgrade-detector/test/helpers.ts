import type { StatusTheme } from '../src/render.js'
import type { ExtensionAPI, ModelRegistry } from '@earendil-works/pi-coding-agent'

export const PLAIN_THEME: StatusTheme = { fg: (_color, text) => text }

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
  thinkingLevel: string | undefined
}

export interface Harness {
  pi: ExtensionAPI
  commands: Map<string, CommandRegistration>
  ui: UiRecorder
  context: HarnessContext
  emit: (event: string, payload: unknown) => void
}

export interface RegistryModel {
  id: string
  provider: string
  thinkingLevelMap?: Record<string, string | null> | undefined
}

export function createRegistry(models: RegistryModel[] = []): ModelRegistry {
  return {
    getAll: () => models,
    find: (provider: string, modelId: string) =>
      models.find(model => model.provider === provider && model.id === modelId),
  } as unknown as ModelRegistry
}

export function createHarness(registry: ModelRegistry = createRegistry()): Harness {
  const handlers = new Map<string, ((event: unknown, context: unknown) => void)[]>()
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
    thinkingLevel: undefined,
  }

  const pi = {
    on(event: string, handler: (event: unknown, context: unknown) => void) {
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
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) {
        handler(payload, context)
      }
    },
  }
}

export function assistantMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'assistant',
    provider: 'openai-codex',
    model: 'gpt-6-astra',
    content: [],
    ...overrides,
  }
}
