import type { ExtensionAPI, SessionEntry, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { mkdtempSync, rmSync } from 'node:fs'
import { afterEach, beforeEach, vi } from 'vitest'
import sessionHub from '../src/index.js'

type Handler = (event: unknown, context: unknown) => unknown

/** A throwaway agent dir under /tmp, since the Unix sockets inside it need a short path. */
export function useAgentDir(): { root: string } {
  const state = { root: '' }
  beforeEach(() => {
    state.root = mkdtempSync('/tmp/psh-')
    vi.stubEnv('PI_CODING_AGENT_DIR', state.root)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(state.root, { recursive: true, force: true })
  })

  return state
}

export interface SessionOptions {
  id: string
  mode?: string
  entries?: SessionEntry[]
}

export function sessionContext(options: SessionOptions): Record<string, unknown> {
  return {
    cwd: '/project',
    mode: options.mode ?? 'tui',
    sessionManager: {
      getSessionId: () => options.id,
      getSessionFile: () => `/sessions/${options.id}.jsonl`,
      getSessionName: () => undefined,
      getEntries: () => options.entries ?? [],
    },
  }
}

export interface Hub {
  emit: (name: string, event: unknown, context?: unknown) => Promise<unknown[]>
  sent: { message: Record<string, unknown>; options: Record<string, unknown> }[]
  events: { channel: string; data: unknown }[]
  tools: Map<string, ToolDefinition>
}

export function loadHub(): Hub {
  const handlers = new Map<string, Handler[]>()
  const hub: Hub = {
    emit: async (name, event, context) => {
      const results: unknown[] = []
      for (const handler of handlers.get(name) ?? []) {
        results.push(await handler(event, context))
      }

      return results
    },
    sent: [],
    events: [],
    tools: new Map(),
  }
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (tool: ToolDefinition) => hub.tools.set(tool.name, tool),
    registerCommand: () => {},
    sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) =>
      hub.sent.push({ message, options }),
    events: { emit: (channel: string, data: unknown) => hub.events.push({ channel, data }) },
  }
  sessionHub(pi as unknown as ExtensionAPI)

  return hub
}
