import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ModelRegistry, Theme } from '@earendil-works/pi-coding-agent'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import codexDowngradeDetector from '../src/index.js'

const PLAIN_THEME: Pick<Theme, 'fg'> = { fg: (_color, text) => text }

/** A throwaway project and agent dir, with `PI_CODING_AGENT_DIR` pointed at the latter. */
export function useWorkspace(): { cwd: string } {
  const workspace = { cwd: '' }
  let root = ''
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pi-codex-downgrade-detector-'))
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

export interface RegistryModel {
  id: string
  provider: string
  thinkingLevelMap?: Record<string, string | null>
}

export function createRegistry(models: RegistryModel[]): ModelRegistry {
  return {
    getAll: () => models,
    find: (provider: string, modelId: string) =>
      models.find(model => model.provider === provider && model.id === modelId),
  } as unknown as ModelRegistry
}

export interface Harness {
  ui: {
    statuses: (string | undefined)[]
    widgets: (string[] | undefined)[]
    notifications: { message: string; type: string | undefined }[]
  }
  context: { thinkingLevel: string | undefined }
  emit: (event: string, payload: unknown) => void
}

export function createHarness(cwd: string, registry: ModelRegistry): Harness {
  const handlers = new Map<string, ((event: unknown, context: unknown) => void)[]>()
  const ui: Harness['ui'] = { statuses: [], widgets: [], notifications: [] }
  const context = {
    ui: {
      setStatus: (_key: string, text: string | undefined) => ui.statuses.push(text),
      setWidget: (_key: string, content: string[] | undefined) => ui.widgets.push(content),
      notify: (message: string, type?: string) => ui.notifications.push({ message, type }),
      theme: PLAIN_THEME,
    },
    cwd,
    modelRegistry: registry,
    thinkingLevel: undefined as string | undefined,
  }
  const pi = {
    on(event: string, handler: (event: unknown, context: unknown) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    },
    registerCommand() {},
  }
  codexDowngradeDetector(pi as unknown as ExtensionAPI)

  return {
    ui,
    context,
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) {
        handler(payload, context)
      }
    },
  }
}

export function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    model: 'gpt-6-astra',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 0,
    ...overrides,
  }
}
