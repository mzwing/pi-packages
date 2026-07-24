import type { DenialCircuitBreaker } from '../src/circuit-breaker.js'
import type { AutoReviewConfigFileSystem } from '../src/config-store.js'
import type { AutoReviewExtensionDependencies } from '../src/extension.js'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  RegisteredCommand,
} from '@earendil-works/pi-coding-agent'
import type { Authorizer, PermissionsService } from '@gotgenes/pi-permission-system'
import { PERMISSIONS_READY_CHANNEL } from '@gotgenes/pi-permission-system'
import { describe, expect, it, vi } from 'vitest'
import { AutoReviewConfigStore } from '../src/config-store.js'
import { autoReviewConfigSchema } from '../src/config.js'
import { createAutoReviewExtension, createAutoReviewExtensionWithConfigStore } from '../src/extension.js'

type Handler = (...arguments_: unknown[]) => unknown

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

function configResult() {
  return {
    config: autoReviewConfigSchema.parse({}),
    issues: [],
    globalPath: '/global/config.json',
    projectPath: '/project/config.json',
  }
}

function createConfigStore(initial: Record<string, string>) {
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
  it('registers once when session_start happens before permissions:ready', () => {
    const harness = createPiHarness()
    const dispose = vi.fn()
    const registerAuthorizer = vi.fn(() => dispose)
    let service: PermissionsService | undefined
    const authorize = vi.fn<Authorizer['authorize']>()

    createAutoReviewExtension(harness.pi, {
      loadConfig: configResult,
      getPermissionsService: () => service,
      createReviewer: () => authorize,
    })

    harness.emit('session_start', {}, context())
    expect(registerAuthorizer).not.toHaveBeenCalled()

    service = { registerAuthorizer } as unknown as PermissionsService
    harness.emitEvent(PERMISSIONS_READY_CHANNEL, {})
    harness.emitEvent(PERMISSIONS_READY_CHANNEL, {})

    expect(registerAuthorizer).toHaveBeenCalledOnce()
    expect(registerAuthorizer).toHaveBeenCalledWith('auto-review', authorize)

    harness.emit('session_shutdown')
    expect(dispose).toHaveBeenCalledOnce()

    harness.emit('session_start', {}, context())
    expect(registerAuthorizer).toHaveBeenCalledTimes(2)
  })

  it('registers when permissions:ready happens before session_start', () => {
    const harness = createPiHarness()
    const registerAuthorizer = vi.fn(() => vi.fn())
    const service = {
      registerAuthorizer,
    } as unknown as PermissionsService

    createAutoReviewExtension(harness.pi, {
      loadConfig: configResult,
      getPermissionsService: () => service,
      createReviewer: () => vi.fn<Authorizer['authorize']>(),
    })

    harness.emitEvent(PERMISSIONS_READY_CHANNEL, {})
    expect(registerAuthorizer).not.toHaveBeenCalled()

    harness.emit('session_start', {}, context())
    expect(registerAuthorizer).toHaveBeenCalledOnce()
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

    createAutoReviewExtension(harness.pi, {
      loadConfig: () => ({
        config: undefined,
        issues: [],
        globalPath: '/global/config.json',
        projectPath: '/project/config.json',
      }),
      getPermissionsService: () => service,
    })
    harness.emit('session_start', {}, context())

    const log = { review: vi.fn(), debug: vi.fn() }
    await expect(
      registered?.(
        {
          requestId: 'request',
          source: 'tool_call',
          agentName: null,
          message: 'request',
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

    createAutoReviewExtensionWithConfigStore(harness.pi, store, {
      getPermissionsService: () => service,
      createReviewer,
    })
    harness.emit('session_start', {}, context())
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
    const createReviewer = vi.fn(() => vi.fn<Authorizer['authorize']>())
    const notify = vi.fn()

    createAutoReviewExtensionWithConfigStore(harness.pi, store, {
      getPermissionsService: () => ({ registerAuthorizer }) as unknown as PermissionsService,
      createReviewer,
    })
    harness.emit('session_start', {}, context())
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

  it('restores the old reviewer if candidate registration fails', async () => {
    const globalPath = '/agent/extensions/pi-permission-auto-review/config.json'
    const { store } = createConfigStore({
      [globalPath]: JSON.stringify({ reasoning: 'high' }),
    })
    const harness = createPiHarness()
    const firstDispose = vi.fn()
    const restoredDispose = vi.fn()
    const firstAuthorize = vi.fn<Authorizer['authorize']>()
    const secondAuthorize = vi.fn<Authorizer['authorize']>()
    const registerAuthorizer = vi
      .fn()
      .mockReturnValueOnce(firstDispose)
      .mockImplementationOnce(() => {
        throw new Error('candidate rejected')
      })
      .mockReturnValueOnce(restoredDispose)
    const notify = vi.fn()

    createAutoReviewExtensionWithConfigStore(harness.pi, store, {
      getPermissionsService: () => ({ registerAuthorizer }) as unknown as PermissionsService,
      createReviewer: vi.fn().mockReturnValueOnce(firstAuthorize).mockReturnValueOnce(secondAuthorize),
    })
    harness.emit('session_start', {}, context())

    await harness.getCommand('permission-auto-review')?.handler('reset global', commandContext(notify))

    expect(firstDispose).toHaveBeenCalledOnce()
    expect(registerAuthorizer).toHaveBeenNthCalledWith(2, 'auto-review', secondAuthorize)
    expect(registerAuthorizer).toHaveBeenNthCalledWith(3, 'auto-review', firstAuthorize)
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('old reviewer was restored'), 'error')

    harness.emit('session_shutdown')
    expect(restoredDispose).toHaveBeenCalledOnce()
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

    createAutoReviewExtensionWithConfigStore(harness.pi, store, {
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
    harness.emitEvent(PERMISSIONS_READY_CHANNEL, {})
    expect(registerAuthorizer).toHaveBeenCalledWith('auto-review', pendingAuthorize)
  })
})
