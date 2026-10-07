import type { AgentToolResult, ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent'
import taskGovernor from '../src/index.js'

type Handler = (event: unknown, context: unknown) => unknown
interface Command {
  handler: (args: string, context: unknown) => Promise<void>
}

export interface SessionOptions {
  cwd: string
  sessionId: string
  mode?: string
  /** Value of the --governor-store flag, as an executor is started with. */
  store?: string
}

export interface Governor {
  notices: { message: string; type: string }[]
  statuses: (string | undefined)[]
  sent: { message: { content: string }; options: unknown }[]
  tools: Map<string, ToolDefinition>
  active: () => string[]
  emit: (name: string, event?: unknown) => Promise<unknown[]>
  start: () => Promise<unknown[]>
  command: (args: string) => Promise<void>
  tool: (name: string, params: object) => Promise<AgentToolResult<unknown>>
}

/** The governor loaded into a fake Pi session, with what it shows and sends recorded. */
export function loadGovernor(options: SessionOptions): Governor {
  const handlers = new Map<string, Handler[]>()
  const eventHandlers = new Map<string, Handler[]>()
  const tools = new Map<string, ToolDefinition>()
  const commands = new Map<string, Command>()
  let active = ['read', 'bash', 'edit', 'write', 'session_list', 'session_spawn', 'subagent']
  const notices: { message: string; type: string }[] = []
  const statuses: (string | undefined)[] = []
  const sent: { message: { content: string }; options: unknown }[] = []
  const context = {
    cwd: options.cwd,
    mode: options.mode ?? 'tui',
    ui: {
      notify: (message: string, type: string) => notices.push({ message, type }),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
    },
    sessionManager: {
      getSessionId: () => options.sessionId,
      getSessionFile: () => undefined,
    },
    model: undefined,
    isProjectTrusted: () => true,
  }
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    events: {
      on: (name: string, handler: Handler) => eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]),
    },
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    registerFlag: () => {},
    getFlag: () => options.store,
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names
    },
    sendMessage: (message: { content: string }, sendOptions: unknown) => sent.push({ message, options: sendOptions }),
  }
  taskGovernor(pi as unknown as ExtensionAPI)

  async function emit(name: string, event: unknown = {}): Promise<unknown[]> {
    const results: unknown[] = []
    for (const handler of handlers.get(name) ?? []) {
      results.push(await handler(event, context))
    }

    return results
  }

  return {
    notices,
    statuses,
    sent,
    tools,
    active: () => active,
    emit,
    start: async () => emit('session_start', { reason: 'startup' }),
    command: async (args: string) => commands.get('governor')!.handler(args, context),
    tool: async (name: string, params: object) =>
      tools.get(name)!.execute('call', params, undefined, undefined, context as never),
  }
}
