import type { DenialCircuitBreaker } from '../src/circuit-breaker.js'
import type { AutoReviewConfigFileSystem } from '../src/config-store.js'
import type { AutoReviewExtensionDependencies } from '../src/extension.js'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  RegisteredCommand,
} from '@earendil-works/pi-coding-agent'
import type {
  Authorizer,
  PermissionsReadyEvent,
  PermissionsService,
  PromptPayload,
} from '@gotgenes/pi-permission-system'
import { PERMISSIONS_READY_CHANNEL } from '@gotgenes/pi-permission-system'
import { describe, expect, it, vi } from 'vitest'
import { AutoReviewConfigStore } from '../src/config-store.js'
import { createAutoReviewExtension } from '../src/extension.js'

type Handler = (...arguments_: unknown[]) => unknown

const SESSION_ID = 'session-root'

function createPiHarness() {
  const handlers = new Map<string, Handler[]>()
  const eventHandlers = new Map<string, Handler[]>()
  const commands = new Map<string, Omit<RegisteredCommand, 'name' | 'sourceInfo'>>()
  const add = (target: Map<string, Handler[]>, name: string, handler: Handler): void => {
    target.set(name, [...(target.get(name) ?? []), handler])
  }
  const pi = {
    on: vi.fn((name: string, handler: Handler) => add(handlers, name, handler)),
    events: {
      on: vi.fn((name: string, handler: Handler) => add(eventHandlers, name, handler)),
    },
    registerCommand: vi.fn((name: string, command: Omit<RegisteredCommand, 'name' | 'sourceInfo'>) => {
      commands.set(name, command)
    }),
  } as unknown as ExtensionAPI

  return {
    pi,
    emit(name: string, ...arguments_: unknown[]) {
      for (const handler of handlers.get(name) ?? []) {
        handler(...arguments_)
      }
    },
    emitEvent(name: string, ...arguments_: unknown[]) {
      for (const handler of eventHandlers.get(name) ?? []) {
        handler(...arguments_)
      }
    },
    emitReady(sessionId: string | null = SESSION_ID) {
      this.emitEvent(PERMISSIONS_READY_CHANNEL, {
        sessionId,
        adjudicatesLocally: true,
      } satisfies PermissionsReadyEvent)
    },
    getCommand(name: string) {
      return commands.get(name)
    },
  }
}

function context(): ExtensionContext {
  return {
    cwd: '/project',
    modelRegistry: {},
    sessionManager: {},
  } as ExtensionContext
}

function promptPayload(): PromptPayload {
  return {
    kind: 'bash',
    request: {
      requester: { agentName: null, forwarded: false, sessionId: null },
      surface: 'bash',
      toolName: 'bash',
      invokedToolName: null,
      value: 'pnpm publish',
      matchedPattern: null,
      commandContext: null,
      executedUnit: null,
    },
    evidence: [],
    annotations: [],
  }
}

function createConfigStore(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const fileSystem: AutoReviewConfigFileSystem = {
    readFile: path => files.get(path),
    writeFile: (path, source) => {
      files.set(path, source)
    },
    rename: (sourcePath, destinationPath) => {
      const source = files.get(sourcePath)
      if (source === undefined) {
        throw new Error(`missing ${sourcePath}`)
      }
      files.set(destinationPath, source)
      files.delete(sourcePath)
    },
    mkdir: () => {},
    unlink: path => {
      files.delete(path)
    },
  }
  return {
    files,
    store: new AutoReviewConfigStore({ agentDir: '/agent', fileSystem }),
  }
}

function commandContext(notify = vi.fn()): ExtensionCommandContext {
  return {
    ...context(),
    mode: 'tui',
    hasUI: true,
    ui: {
      confirm: vi.fn(async () => true),
      notify,
    },
    waitForIdle: vi.fn(async () => {}),
    reload: vi.fn(),
  } as unknown as ExtensionCommandContext
}

describe('extension lifecycle', () => {
  it('registers once even though permissions:ready repeats', () => {
    const harness = createPiHarness()
    const dispose = vi.fn()
    const registerAuthorizer = vi.fn(() => dispose)
    const service = { registerAuthorizer } as unknown as PermissionsService
    const authorize = vi.fn<Authorizer['authorize']>()

    createAutoReviewExtension(harness.pi, {
      configStore: createConfigStore().store,
      getPermissionsService: id => (id === SESSION_ID ? service : undefined),
      createReviewer: () => authorize,
    })

    harness.emit('session_start', {}, context())
    expect(registerAuthorizer).not.toHaveBeenCalled()

    // Ready fires at session_start and again at the first before_agent_start.
    harness.emitReady()
    harness.emitReady()

    expect(registerAuthorizer).toHaveBeenCalledOnce()
    expect(registerAuthorizer).toHaveBeenCalledWith('auto-review', authorize)

    harness.emit('session_shutdown')
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('registers on the repeat emission when ready precedes session_start', () => {
    const harness = createPiHarness()
    const registerAuthorizer = vi.fn(() => vi.fn())
    const service = { registerAuthorizer } as unknown as PermissionsService

    createAutoReviewExtension(harness.pi, {
      configStore: createConfigStore().store,
      getPermissionsService: () => service,
      createReviewer: () => vi.fn<Authorizer['authorize']>(),
    })

    // No reviewer generation exists yet, so the first emission cannot register.
    harness.emitReady()
    expect(registerAuthorizer).not.toHaveBeenCalled()

    harness.emit('session_start', {}, context())
    expect(registerAuthorizer).not.toHaveBeenCalled()

    harness.emitReady()
    expect(registerAuthorizer).toHaveBeenCalledOnce()
  })

  it('registers each node into the service keyed by its own session id', () => {
    const rootHarness = createPiHarness()
    const childHarness = createPiHarness()
    const rootDispose = vi.fn()
    const childDispose = vi.fn()
    const rootRegister = vi.fn(() => rootDispose)
    const childRegister = vi.fn(() => childDispose)
    const services = new Map<string, PermissionsService>([
      [SESSION_ID, { registerAuthorizer: rootRegister } as unknown as PermissionsService],
      ['session-subagent', { registerAuthorizer: childRegister } as unknown as PermissionsService],
    ])
    const resolve = (id: string) => services.get(id)

    for (const harness of [rootHarness, childHarness]) {
      createAutoReviewExtension(harness.pi, {
        configStore: createConfigStore().store,
        getPermissionsService: resolve,
        createReviewer: () => vi.fn<Authorizer['authorize']>(),
      })
      harness.emit('session_start', {}, context())
    }

    rootHarness.emitReady()
    childHarness.emitReady('session-subagent')

    expect(rootRegister).toHaveBeenCalledOnce()
    expect(childRegister).toHaveBeenCalledOnce()

    // Each instance holds its own handle, so a shutdown never disposes another
    // node's registration.
    childHarness.emit('session_shutdown')
    expect(childDispose).toHaveBeenCalledOnce()
    expect(rootDispose).not.toHaveBeenCalled()

    rootHarness.emit('session_shutdown')
    expect(rootDispose).toHaveBeenCalledOnce()
  })

  it('warns once and stays unregistered when the node published no keyed service', () => {
    const harness = createPiHarness()
    const registerAuthorizer = vi.fn(() => vi.fn())
    const service = { registerAuthorizer } as unknown as PermissionsService
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    createAutoReviewExtension(harness.pi, {
      configStore: createConfigStore().store,
      getPermissionsService: () => service,
      createReviewer: () => vi.fn<Authorizer['authorize']>(),
    })

    harness.emit('session_start', {}, context())
    harness.emitReady(null)
    harness.emitReady(null)

    expect(registerAuthorizer).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('published no keyed service'))

    warn.mockRestore()
  })

  it('registers a defer-only reviewer when config is invalid', async () => {
    const harness = createPiHarness()
    let registered: Authorizer['authorize'] | undefined
    const service = {
      registerAuthorizer: vi.fn((_name: string, authorize: Authorizer['authorize']) => {
        registered = authorize
        return vi.fn()
      }),
    } as unknown as PermissionsService
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    createAutoReviewExtension(harness.pi, {
      configStore: createConfigStore({
        '/agent/extensions/pi-permission-auto-review/config.json': JSON.stringify({ apiKey: 'not-allowed' }),
      }).store,
      getPermissionsService: () => service,
    })
    harness.emit('session_start', {}, context())
    harness.emitReady()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('config issue'))
    warn.mockRestore()

    const log = { review: vi.fn(), debug: vi.fn() }
    await expect(
      registered?.(
        {
          requestId: 'request',
          source: 'tool_call',
          agentName: null,
          payload: promptPayload(),
        },
        {} as never,
        log,
      ),
    ).resolves.toEqual({ kind: 'defer' })
    expect(log.review).toHaveBeenCalledWith(
      'auto_review.decision',
      expect.objectContaining({ errorCategory: 'config-invalid' }),
    )
  })

  it('hot-swaps only the reviewer generation after a config reset', async () => {
    const globalPath = '/agent/extensions/pi-permission-auto-review/config.json'
    const { files, store } = createConfigStore({
      [globalPath]: JSON.stringify({ model: 'old-review-model' }),
    })
    const harness = createPiHarness()
    const firstDispose = vi.fn()
    const secondDispose = vi.fn()
    const firstAuthorize = vi.fn<Authorizer['authorize']>()
    const secondAuthorize = vi.fn<Authorizer['authorize']>()
    const createReviewer = vi
      .fn<NonNullable<AutoReviewExtensionDependencies['createReviewer']>>()
      .mockReturnValueOnce(firstAuthorize)
      .mockReturnValueOnce(secondAuthorize)
    const registerAuthorizer = vi.fn().mockReturnValueOnce(firstDispose).mockReturnValueOnce(secondDispose)
    const service = { registerAuthorizer } as unknown as PermissionsService

    createAutoReviewExtension(harness.pi, {
      configStore: store,
      getPermissionsService: () => service,
      createReviewer,
    })
    harness.emit('session_start', {}, context())
    harness.emitReady()
    const circuitBreaker: DenialCircuitBreaker | undefined = createReviewer.mock.calls[0]?.[0].circuitBreaker
    if (circuitBreaker === undefined) {
      throw new Error('reviewer was not created')
    }
    circuitBreaker.recordDenied()
    circuitBreaker.recordDenied()
    circuitBreaker.recordDenied()
    expect(circuitBreaker.isOpen()).toBe(true)

    const command = harness.getCommand('permission-auto-review')
    const ctx = commandContext()
    await command?.handler('reset global', ctx)

    expect(files.has(globalPath)).toBe(false)
    expect(firstDispose).toHaveBeenCalledOnce()
    expect(registerAuthorizer).toHaveBeenNthCalledWith(1, 'auto-review', firstAuthorize)
    expect(registerAuthorizer).toHaveBeenNthCalledWith(2, 'auto-review', secondAuthorize)
    expect(createReviewer.mock.calls[0]?.[0]).toMatchObject({
      config: { model: 'old-review-model' },
    })
    expect(createReviewer.mock.calls[1]?.[0]).toMatchObject({
      config: { model: 'codex-auto-review' },
    })
    expect(circuitBreaker.isOpen()).toBe(false)

    harness.emit('session_shutdown')
    expect(secondDispose).toHaveBeenCalledOnce()
  })

  it('preserves the old reviewer when reset leaves the merged config invalid', async () => {
    const globalPath = '/agent/extensions/pi-permission-auto-review/config.json'
    const projectPath = '/project/.pi/extensions/pi-permission-auto-review/config.json'
    const { files, store } = createConfigStore({
      [globalPath]: JSON.stringify({ reasoning: 'high' }),
      [projectPath]: JSON.stringify({
        includeBaselinePolicy: false,
        additionalPolicy: 'Review conservatively.',
      }),
    })
    const harness = createPiHarness()
    const firstDispose = vi.fn()
    const registerAuthorizer = vi.fn(() => firstDispose)
    const service = { registerAuthorizer } as unknown as PermissionsService
    const createReviewer = vi.fn(() => vi.fn<Authorizer['authorize']>())
    const notify = vi.fn()

    createAutoReviewExtension(harness.pi, {
      configStore: store,
      getPermissionsService: () => service,
      createReviewer,
    })
    harness.emit('session_start', {}, context())
    harness.emitReady()
    files.set(projectPath, JSON.stringify({ includeBaselinePolicy: false }))

    await harness.getCommand('permission-auto-review')?.handler('reset global', commandContext(notify))

    expect(files.has(globalPath)).toBe(false)
    expect(firstDispose).not.toHaveBeenCalled()
    expect(registerAuthorizer).toHaveBeenCalledOnce()
    expect(createReviewer).toHaveBeenCalledOnce()
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('the merged config is invalid; the previous reviewer remains active'),
      'error',
    )
  })

  it('reports a failed swap and retries the new generation at the next ready', async () => {
    const globalPath = '/agent/extensions/pi-permission-auto-review/config.json'
    const { store } = createConfigStore({
      [globalPath]: JSON.stringify({ reasoning: 'high' }),
    })
    const harness = createPiHarness()
    const firstDispose = vi.fn()
    const secondDispose = vi.fn()
    const firstAuthorize = vi.fn<Authorizer['authorize']>()
    const secondAuthorize = vi.fn<Authorizer['authorize']>()
    const registerAuthorizer = vi
      .fn()
      .mockReturnValueOnce(firstDispose)
      .mockImplementationOnce(() => {
        throw new Error('candidate rejected')
      })
      .mockReturnValueOnce(secondDispose)
    const service = { registerAuthorizer } as unknown as PermissionsService
    const notify = vi.fn()

    createAutoReviewExtension(harness.pi, {
      configStore: store,
      getPermissionsService: () => service,
      createReviewer: vi.fn().mockReturnValueOnce(firstAuthorize).mockReturnValueOnce(secondAuthorize),
    })
    harness.emit('session_start', {}, context())
    harness.emitReady()

    await harness.getCommand('permission-auto-review')?.handler('reset global', commandContext(notify))

    // The old link is released before the new one is offered, so a rejected
    // registration leaves the ask path with no link at all rather than a
    // reviewer running the superseded config.
    expect(firstDispose).toHaveBeenCalledOnce()
    expect(registerAuthorizer).toHaveBeenNthCalledWith(2, 'auto-review', secondAuthorize)
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('could not be registered'), 'error')

    harness.emitReady()
    expect(registerAuthorizer).toHaveBeenNthCalledWith(3, 'auto-review', secondAuthorize)

    harness.emit('session_shutdown')
    expect(secondDispose).toHaveBeenCalledOnce()
  })

  it('keeps a saved generation pending until permission-system becomes ready', async () => {
    const globalPath = '/agent/extensions/pi-permission-auto-review/config.json'
    const { store } = createConfigStore({
      [globalPath]: JSON.stringify({ reasoning: 'high' }),
    })
    const harness = createPiHarness()
    const oldAuthorize = vi.fn<Authorizer['authorize']>()
    const pendingAuthorize = vi.fn<Authorizer['authorize']>()
    const createReviewer = vi.fn().mockReturnValueOnce(oldAuthorize).mockReturnValueOnce(pendingAuthorize)
    const registerAuthorizer = vi.fn(() => vi.fn())
    let service: PermissionsService | undefined
    const notify = vi.fn()

    createAutoReviewExtension(harness.pi, {
      configStore: store,
      getPermissionsService: () => service,
      createReviewer,
    })
    harness.emit('session_start', {}, context())
    await harness.getCommand('permission-auto-review')?.handler('reset global', commandContext(notify))

    expect(registerAuthorizer).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('will activate when pi-permission-system is ready'),
      'warning',
    )

    service = { registerAuthorizer } as unknown as PermissionsService
    harness.emitReady()
    expect(registerAuthorizer).toHaveBeenCalledWith('auto-review', pendingAuthorize)
  })
})
