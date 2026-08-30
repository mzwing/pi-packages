import type { CatalogCacheFileSystem } from '../src/cache.js'
import type { LoadConfigResult } from '../src/config.js'
import type { CatalogFetcher, FetchOutcome } from '../src/fetcher.js'
import type { ModelInfoConfig, SnapshotModel } from '../src/types.js'
import type { ExtensionAPI, ModelRegistry } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import { CatalogCache } from '../src/cache.js'
import { CatalogStore } from '../src/catalog.js'
import { createModelInfoExtension } from '../src/extension.js'
import { ProviderApplier } from '../src/provider-apply.js'
import { makeSnapshot } from './helpers.js'

const PI_DEV_PAYLOAD = {
  openai: {
    'gpt-5.5': {
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      api: 'openai-completions',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 400_000,
      maxTokens: 128_000,
    },
  },
}

interface Harness {
  pi: ExtensionAPI
  registrations: { id: string; config: Record<string, unknown> }[]
  unregistered: string[]
  commands: Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions?: (prefix: string) => unknown }
  >
  emit: (event: string, context: unknown) => void
}

function createPiHarness(): Harness {
  const handlers = new Map<string, ((event: unknown, context: unknown) => void)[]>()
  const registrations: Harness['registrations'] = []
  const unregistered: string[] = []
  const commands: Harness['commands'] = new Map()

  const pi = {
    on(event: string, handler: (event: unknown, context: unknown) => void) {
      const bucket = handlers.get(event) ?? []
      bucket.push(handler)
      handlers.set(event, bucket)
    },
    registerProvider(id: string, config: Record<string, unknown>) {
      registrations.push({ id, config })
    },
    unregisterProvider(id: string) {
      unregistered.push(id)
    },
    registerCommand(name: string, options: Harness['commands'] extends Map<string, infer V> ? V : never) {
      commands.set(name, options)
    },
    events: { on: () => () => {}, emit: () => {} },
  }

  return {
    pi: pi as unknown as ExtensionAPI,
    registrations,
    unregistered,
    commands,
    emit(event, context) {
      for (const handler of handlers.get(event) ?? []) {
        handler({}, context)
      }
    },
  }
}

interface RegistryOptions {
  models?: SnapshotModel[]
  registeredConfig?: Record<string, unknown> | undefined
  nativeProvider?: unknown
  dynamic?: boolean
  missing?: boolean
}

function createRegistry(options: RegistryOptions = {}): ModelRegistry & { models: SnapshotModel[] } {
  const state = {
    models: options.models ?? [makeSnapshot()],
    getProvider(id: string) {
      if (options.missing === true) {
        return undefined
      }
      return {
        id,
        getModels: () => state.models,
        ...(options.dynamic === true ? { refreshModels: async () => {} } : {}),
      }
    },
    getRegisteredProviderConfig: () => options.registeredConfig,
    getRegisteredNativeProvider: () => options.nativeProvider,
    find: (_provider: string, modelId: string) => state.models.find(model => model.id === modelId),
  }
  return state as unknown as ModelRegistry & { models: SnapshotModel[] }
}

function memoryFs(): CatalogCacheFileSystem {
  const files = new Map<string, string>()
  return {
    readFile: path => files.get(path),
    writeFile: (path, data) => {
      files.set(path, data)
    },
    rename: (from, to) => {
      const data = files.get(from)
      files.delete(from)
      if (data !== undefined) {
        files.set(to, data)
      }
    },
    mkdir: () => {},
    unlink: path => {
      files.delete(path)
    },
  }
}

function okFetcher(): CatalogFetcher {
  return {
    get: async (request): Promise<FetchOutcome> =>
      request.url.includes('pi.dev')
        ? { status: 'ok', body: PI_DEV_PAYLOAD, etag: undefined, lastModified: undefined }
        : { status: 'ok', body: {}, etag: undefined, lastModified: undefined },
  }
}

interface SetupOptions {
  config?: ModelInfoConfig
  registry?: ModelRegistry
  fetcher?: CatalogFetcher
  isIdle?: boolean
}

function setup(options: SetupOptions = {}) {
  const harness = createPiHarness()
  const tasks: (() => void)[] = []
  const warnings: string[] = []
  const fs = memoryFs()
  const registry = options.registry ?? createRegistry()

  const loadConfig = vi.fn<(cwd: string, agentDir: string) => LoadConfigResult>(() => ({
    config: options.config ?? { providers: { relay: {} } },
    issues: [],
    globalPath: '/agent/config.json',
    projectPath: '/project/config.json',
  }))
  const readUserAuthored = vi.fn(() => new Map())

  createModelInfoExtension(harness.pi, {
    catalogStore: new CatalogStore({
      cache: new CatalogCache({ dir: '/cache', fileSystem: fs }),
      fetcher: options.fetcher ?? okFetcher(),
      now: () => 1_000_000,
      random: () => 0.5,
    }),
    applier: new ProviderApplier({ warn: message => warnings.push(message) }),
    loadConfig,
    readUserAuthored,
    agentDir: '/agent',
    schedule: task => tasks.push(task),
    warn: message => warnings.push(message),
  })

  const context = { cwd: '/project', modelRegistry: registry, isIdle: () => options.isIdle ?? true }

  return {
    ...harness,
    registry,
    warnings,
    tasks,
    loadConfig,
    readUserAuthored,
    context,
    start: () => harness.emit('session_start', context),
    async flush() {
      const pending = [...tasks]
      tasks.length = 0
      for (const task of pending) {
        task()
      }
      await new Promise(resolve => setImmediate(resolve))
    },
  }
}

describe('factory', () => {
  it('registers handlers and the command without doing any I/O', () => {
    const failingFs: CatalogCacheFileSystem = {
      readFile: () => {
        throw new Error('the factory must not touch the disk')
      },
      writeFile: () => {
        throw new Error('the factory must not touch the disk')
      },
      rename: () => {},
      mkdir: () => {},
      unlink: () => {},
    }
    const harness = createPiHarness()
    expect(() =>
      createModelInfoExtension(harness.pi, {
        catalogStore: new CatalogStore({ cache: new CatalogCache({ dir: '/c', fileSystem: failingFs }) }),
        loadConfig: () => {
          throw new Error('the factory must not read config')
        },
        schedule: () => {},
      }),
    ).not.toThrow()
    expect(harness.commands.has('model-info')).toBe(true)
  })
})

describe('session start', () => {
  it('returns before the catalog resolves, then registers once it does', async () => {
    const harness = setup()
    harness.start()
    expect(harness.registrations).toHaveLength(0)

    await harness.flush()
    expect(harness.registrations).toHaveLength(1)
  })

  it('does nothing when no provider is opted in', async () => {
    const harness = setup({ config: { providers: {} } })
    harness.start()
    await harness.flush()
    expect(harness.registrations).toHaveLength(0)
  })

  it('skips a provider Pi does not have', async () => {
    const harness = setup({ registry: createRegistry({ missing: true }) })
    harness.start()
    await harness.flush()
    expect(harness.registrations).toHaveLength(0)
    expect(harness.warnings.join('\n')).toContain('not present in Pi')
  })

  it('refuses a provider another extension registered natively', async () => {
    // registerProvider deletes the native registration, so we would destroy it.
    const harness = setup({ registry: createRegistry({ nativeProvider: { id: 'relay' } }) })
    harness.start()
    await harness.flush()
    expect(harness.registrations).toHaveLength(0)
    expect(harness.warnings.join('\n')).toContain('native provider')
  })

  it('skips a provider with no models to complete', async () => {
    const harness = setup({ registry: createRegistry({ models: [] }) })
    harness.start()
    await harness.flush()
    expect(harness.registrations).toHaveLength(0)
    expect(harness.warnings.join('\n')).toContain('no models to complete')
  })

  it('warns about a dynamically refreshing provider but still completes it', async () => {
    const harness = setup({ registry: createRegistry({ dynamic: true }) })
    harness.start()
    await harness.flush()
    expect(harness.registrations).toHaveLength(1)
    expect(harness.warnings.join('\n')).toContain('freezes')
  })
})

describe('registration shape', () => {
  it('sends exactly one key, and every snapshot model', async () => {
    const models = [makeSnapshot({ id: 'gpt-5.5' }), makeSnapshot({ id: 'mystery-model' })]
    const harness = setup({ registry: createRegistry({ models }) })
    harness.start()
    await harness.flush()

    const [registration] = harness.registrations
    expect(Object.keys(registration?.config ?? {})).toEqual(['models'])

    const registered = registration?.config['models'] as SnapshotModel[]
    expect(registered.map(model => model.id).sort()).toEqual(['gpt-5.5', 'mystery-model'])
  })

  it('completes what it resolved and copies the rest verbatim', async () => {
    const models = [makeSnapshot({ id: 'gpt-5.5' }), makeSnapshot({ id: 'mystery-model', contextWindow: 4_096 })]
    const harness = setup({ registry: createRegistry({ models }) })
    harness.start()
    await harness.flush()

    const registered = harness.registrations[0]?.config['models'] as SnapshotModel[]
    expect(registered.find(model => model.id === 'gpt-5.5')?.contextWindow).toBe(400_000)
    expect(registered.find(model => model.id === 'mystery-model')?.contextWindow).toBe(4_096)
  })

  it('pins api and baseUrl from the snapshot', async () => {
    const harness = setup()
    harness.start()
    await harness.flush()

    const registered = harness.registrations[0]?.config['models'] as SnapshotModel[]
    expect(registered[0]?.api).toBe('openai-completions')
    expect(registered[0]?.baseUrl).toBe('http://localhost:8317/v1')
  })

  it('carries headers, compat and samplingParams through', async () => {
    const model = makeSnapshot({
      headers: { 'x-relay': '1' },
      samplingParams: { top_p: 0.9 },
      compat: { supportsStrictMode: true } as never,
    })
    const harness = setup({ registry: createRegistry({ models: [model] }) })
    harness.start()
    await harness.flush()

    const registered = harness.registrations[0]?.config['models'] as SnapshotModel[]
    expect(registered[0]?.headers).toEqual({ 'x-relay': '1' })
    expect(registered[0]?.samplingParams).toEqual({ top_p: 0.9 })
  })
})

describe('cohabitation with a discovery extension', () => {
  // pi-openai-api-models-sync registers `{ ...provider, models }`, so its entry holds
  // the relay's credentials. Taking any of that away breaks authentication.
  const siblingConfig = {
    api: 'openai-completions',
    apiKey: '!cat /run/secret',
    authHeader: true,
    baseUrl: 'http://localhost:8317/v1',
    models: [{ id: 'gpt-5.5' }],
  }

  it('completes the models it discovered without touching its keys', async () => {
    const harness = setup({
      registry: createRegistry({
        models: [makeSnapshot({ id: 'gpt-5.5' })],
        registeredConfig: { ...siblingConfig },
      }),
    })
    harness.start()
    await harness.flush()

    expect(Object.keys(harness.registrations[0]?.config ?? {})).toEqual(['models'])
    expect(harness.unregistered).toEqual([])
    expect(siblingConfig.apiKey).toBe('!cat /run/secret')

    const registered = harness.registrations[0]?.config['models'] as SnapshotModel[]
    expect(registered[0]?.contextWindow).toBe(400_000)
  })

  it('keeps the sibling values byte-for-byte when the catalogs cannot resolve a model', async () => {
    const sibling = makeSnapshot({ id: 'house-model', contextWindow: 65_536, maxTokens: 8_192, reasoning: true })
    const harness = setup({
      registry: createRegistry({ models: [sibling], registeredConfig: { ...siblingConfig } }),
    })
    harness.start()
    await harness.flush()

    const registered = harness.registrations[0]?.config['models'] as SnapshotModel[]
    expect(registered[0]).toMatchObject({
      contextWindow: 65_536,
      maxTokens: 8_192,
      reasoning: true,
      cost: sibling.cost,
    })
  })

  it('defers to the sibling when the provider asks it to', async () => {
    const harness = setup({
      config: { providers: { relay: { contextWindowPolicy: 'keep' } } },
      registry: createRegistry({ models: [makeSnapshot({ contextWindow: 65_536 })] }),
    })
    harness.start()
    await harness.flush()

    const registered = harness.registrations[0]?.config['models'] as SnapshotModel[]
    expect(registered[0]?.contextWindow).toBe(65_536)
  })

  it('re-completes when a third party changes the list mid-session', async () => {
    const registry = createRegistry({ models: [makeSnapshot({ id: 'gpt-5.5' })] })
    const harness = setup({ registry })
    harness.start()
    await harness.flush()
    expect(harness.registrations).toHaveLength(1)

    registry.models = [...registry.models, makeSnapshot({ id: 'late-arrival' })]
    harness.emit('before_agent_start', harness.context)

    expect(harness.registrations).toHaveLength(2)
    const registered = harness.registrations[1]?.config['models'] as SnapshotModel[]
    expect(registered.map(model => model.id).sort()).toEqual(['gpt-5.5', 'late-arrival'])
  })

  it('does not re-register when nothing changed', async () => {
    const harness = setup()
    harness.start()
    await harness.flush()
    harness.emit('before_agent_start', harness.context)
    expect(harness.registrations).toHaveLength(1)
  })
})

describe('failure handling', () => {
  it('survives a throwing registerProvider', async () => {
    const harness = setup()
    const pi = harness.pi as unknown as { registerProvider: () => void }
    pi.registerProvider = () => {
      throw new Error('nope')
    }
    harness.start()
    await expect(harness.flush()).resolves.toBeUndefined()
    expect(harness.warnings.join('\n')).toContain('nope')
  })

  it('registers nothing when no catalog is available', async () => {
    const failing: CatalogFetcher = {
      get: async (): Promise<FetchOutcome> => ({ status: 'error', message: 'offline' }),
    }
    const harness = setup({ fetcher: failing })
    harness.start()
    await harness.flush()
    expect(harness.registrations).toHaveLength(0)
  })
})

describe('applying on idle', () => {
  it('defers a mid-turn swap to turn_end', async () => {
    const harness = setup({
      config: { providers: { relay: {} }, applyOnIdleOnly: true },
      isIdle: false,
    })
    harness.start()
    await harness.flush()
    expect(harness.registrations).toHaveLength(0)

    harness.emit('turn_end', harness.context)
    expect(harness.registrations).toHaveLength(1)
  })
})

describe('shutdown', () => {
  it('aborts the in-flight refresh and registers nothing after it', async () => {
    let resolveFetch: ((outcome: FetchOutcome) => void) | undefined
    const slow: CatalogFetcher = {
      get: async () =>
        new Promise<FetchOutcome>(resolve => {
          resolveFetch = resolve
        }),
    }
    const harness = setup({ fetcher: slow })
    harness.start()

    const pending = [...harness.tasks]
    harness.tasks.length = 0
    for (const task of pending) {
      task()
    }

    harness.emit('session_shutdown', harness.context)
    resolveFetch?.({ status: 'ok', body: PI_DEV_PAYLOAD, etag: undefined, lastModified: undefined })
    await new Promise(resolve => setImmediate(resolve))

    expect(harness.registrations).toHaveLength(0)
  })
})
