import type { SnapshotModel } from '../src/types.js'
import type { ExtensionAPI, ModelRegistry } from '@earendil-works/pi-coding-agent'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import modelInfo from '../src/index.js'
import { json, makeSnapshot, stubFetch, useWorkspace, writeFile } from './helpers.js'

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
    'gpt-5.5-mini': {
      id: 'gpt-5.5-mini',
      name: 'GPT-5.5 mini',
      api: 'openai-completions',
      reasoning: true,
      input: ['text'],
      cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    },
  },
}

const IMAGE_MODEL = {
  id: 'gpt-5.5-mini',
  name: 'GPT-5.5 mini Image',
  type: 'image',
  api: 'openrouter-images',
  baseUrl: 'http://localhost:8317/v1',
  input: ['text'],
  output: ['image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

type Handler = (event: unknown, context: unknown) => void
type Refresh = (context: unknown) => Promise<SnapshotModel[]>

interface NativeProvider {
  id: string
  getModels: () => SnapshotModel[]
}

interface RegistryOptions {
  models?: SnapshotModel[]
  /** Image and classifier models, listed only through `getAllModels`. */
  others?: unknown[]
  registeredConfig?: Record<string, unknown> | undefined
  nativeProvider?: unknown
  dynamic?: boolean
}

/** One stable provider object, as Pi has, so a wrapper can read the list underneath it later. */
function createRegistry(options: RegistryOptions = {}) {
  const state = {
    models: options.models ?? [makeSnapshot()],
    /** What `getRegisteredNativeProvider` reports; a test sets it to replay a `/reload`. */
    native: options.nativeProvider,
    registered: options.registeredConfig,
    provider: {
      id: 'relay',
      getModels: () => state.models,
      ...(options.others === undefined ? {} : { getAllModels: () => [...state.models, ...(options.others ?? [])] }),
      ...(options.dynamic === true ? { refreshModels: async () => {} } : {}),
    },
    getProvider: () => state.provider,
    getRegisteredProviderConfig: () => state.registered,
    getRegisteredNativeProvider: () => state.native,
  }

  return state
}

/** Lets the scheduled catalog task run and its fetches settle. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

describe('model info extension', () => {
  const workspace = useWorkspace()
  const configPath = (): string => join(workspace.agentDir, 'extensions', 'pi-model-info', 'config.json')

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  interface SetupOptions {
    config?: unknown
    registry?: ReturnType<typeof createRegistry>
    fetch?: (url: string) => Response | Promise<Response>
    isIdle?: boolean
    modelsJson?: unknown
  }

  function setup(options: SetupOptions = {}) {
    writeFile(configPath(), options.config ?? { providers: { relay: {} } })
    if (options.modelsJson !== undefined) {
      writeFile(join(workspace.agentDir, 'models.json'), options.modelsJson)
    }
    const fetch = stubFetch(options.fetch ?? (url => json(url.includes('pi.dev') ? PI_DEV_PAYLOAD : {})))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const handlers = new Map<string, Handler[]>()
    const registrations: { id: string; config: Record<string, unknown> }[] = []
    const natives: NativeProvider[] = []
    const unregistered: string[] = []
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler])
      },
      registerProvider(idOrProvider: string | NativeProvider, config: Record<string, unknown>) {
        if (typeof idOrProvider === 'string') {
          registrations.push({ id: idOrProvider, config })
        } else {
          natives.push(idOrProvider)
        }
      },
      unregisterProvider(id: string) {
        unregistered.push(id)
      },
      registerCommand() {},
    }
    modelInfo(pi as unknown as ExtensionAPI)

    const registry = options.registry ?? createRegistry()
    const context = {
      cwd: workspace.cwd,
      modelRegistry: registry as unknown as ModelRegistry,
      isIdle: () => options.isIdle ?? true,
    }
    const emit = (event: string): void => {
      for (const handler of handlers.get(event) ?? []) {
        handler({}, context)
      }
    }

    return {
      emit,
      fetch,
      natives,
      pi,
      registrations,
      unregistered,
      start: () => emit('session_start'),
      warnings: () => warn.mock.calls.map(([message]) => String(message)).join('\n'),
      registered: (index = 0) => registrations[index]?.config['models'] as SnapshotModel[],
    }
  }

  describe('session start', () => {
    // Pi awaits `session_start`, so the catalog is fetched after it returns.
    it('returns before the catalog resolves, then registers once it does', async () => {
      const harness = setup()
      harness.start()
      expect(harness.registrations).toHaveLength(0)

      await settle()
      expect(harness.registrations).toHaveLength(1)
    })

    it('does nothing until a provider is opted in', async () => {
      const harness = setup({ config: { providers: {} } })
      harness.start()
      await settle()

      expect(harness.fetch).not.toHaveBeenCalled()
      expect(harness.registrations).toHaveLength(0)
    })

    it('stays inert when the config is invalid', async () => {
      const harness = setup({ config: '{' })
      harness.start()
      await settle()

      expect(harness.registrations).toHaveLength(0)
      expect(harness.warnings()).toContain('invalid JSON')
    })

    // registerProvider drops a native registration, so completing the provider would delete it.
    it('refuses a provider another extension registered natively', async () => {
      const harness = setup({ registry: createRegistry({ nativeProvider: { id: 'relay' } }) })
      harness.start()
      await settle()

      expect(harness.registrations).toHaveLength(0)
      expect(harness.warnings()).toContain('native provider')
    })
  })

  describe('a provider that refreshes its own list', () => {
    const dynamic = (): ReturnType<typeof createRegistry> =>
      createRegistry({ dynamic: true, models: [makeSnapshot({ id: 'gpt-5.5' })] })

    it('wraps the provider instead of registering a replacement list', async () => {
      const harness = setup({ registry: dynamic() })
      harness.start()
      await settle()

      expect(harness.registrations).toHaveLength(0)
      expect(harness.natives[0]?.getModels()[0]?.contextWindow).toBe(400_000)
      expect(harness.warnings()).not.toContain('freezes')
    })

    // No event, no re-registration, no next turn: the list is read late.
    it('completes a model that appears later, on the next read', async () => {
      const registry = dynamic()
      const harness = setup({ registry })
      harness.start()
      await settle()
      registry.models = [...registry.models, makeSnapshot({ id: 'gpt-5.5-mini' })]

      expect(harness.natives[0]?.getModels().map(model => model.contextWindow)).toEqual([400_000, 200_000])
      expect(harness.natives).toHaveLength(1)
    })

    // Pi keeps the native registration across a reload, so a second pass has to unwrap to the base.
    it('reuses its wrapper rather than stacking one across a reload', async () => {
      const registry = dynamic()
      const harness = setup({ registry })
      harness.start()
      await settle()

      registry.native = harness.natives[0]
      harness.start()
      await settle()

      expect(harness.natives[1]).toBe(harness.natives[0])
      expect(harness.natives[1]?.getModels()[0]?.contextWindow).toBe(400_000)
    })

    // Pi rebuilds a models.json list above anything registered underneath, so a wrapper would not survive.
    it('falls back to a replacement list, and warns that it freezes, when models.json defines the provider', async () => {
      const harness = setup({
        registry: dynamic(),
        modelsJson: { providers: { relay: { models: [{ id: 'gpt-5.5' }] } } },
      })
      harness.start()
      await settle()

      expect(harness.natives).toHaveLength(0)
      expect(harness.registrations).toHaveLength(1)
      expect(harness.warnings()).toContain('freezes')
    })
  })

  describe('a sibling that refreshes its own list', () => {
    const definition = {
      id: 'gpt-5.5-mini',
      name: 'gpt-5.5-mini',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    }

    function siblingConfig(refreshModels = async (): Promise<unknown[]> => [{ ...definition }]) {
      return {
        api: 'openai-completions',
        apiKey: '!cat /run/secret',
        baseUrl: 'http://localhost:8317/v1',
        models: [{ id: 'gpt-5.5' }],
        refreshModels,
      }
    }

    it("hands Pi its own refreshModels, which completes what the sibling's returns", async () => {
      const harness = setup({ registry: createRegistry({ registeredConfig: siblingConfig() }) })
      harness.start()
      await settle()

      const config = harness.registrations[0]?.config ?? {}
      expect(Object.keys(config)).toEqual(['models', 'refreshModels'])
      // The provider-level api and baseUrl fill in what the definition left out.
      expect((await (config['refreshModels'] as Refresh)({}))[0]).toMatchObject({
        contextWindow: 200_000,
        baseUrl: 'http://localhost:8317/v1',
      })
    })

    it('keeps a non-chat entry exactly as the sibling wrote it, even under a chat model id', async () => {
      const registered = siblingConfig(async () => [{ ...definition }, IMAGE_MODEL])
      const harness = setup({ registry: createRegistry({ registeredConfig: registered }) })
      harness.start()
      await settle()

      expect((await (harness.registrations[0]?.config['refreshModels'] as Refresh)({}))[1]).toBe(IMAGE_MODEL)
    })

    // Pi merges our keys into the sibling's entry, so the next session reads back our own hook.
    it('does not stack a decorator on a decorator across a reload', async () => {
      let calls = 0
      const registered = siblingConfig(async () => {
        calls += 1

        return [{ ...definition }]
      })
      const harness = setup({ registry: createRegistry({ registeredConfig: registered }) })
      harness.start()
      await settle()

      Object.assign(registered, harness.registrations[0]?.config)
      harness.start()
      await settle()
      await (harness.registrations[1]?.config['refreshModels'] as Refresh)({})

      expect(calls).toBe(1)
    })
  })

  describe('registration', () => {
    // pi-openai-api-models-sync registers `{ ...provider, models }`, so the entry holds the relay's credentials.
    it("sends only models, so a sibling's apiKey survives, and keeps an unresolved model byte for byte", async () => {
      const unknown = makeSnapshot({ id: 'house-model', contextWindow: 65_536, maxTokens: 8_192, reasoning: true })
      const harness = setup({
        registry: createRegistry({
          models: [makeSnapshot({ id: 'gpt-5.5' }), unknown],
          registeredConfig: { api: 'openai-completions', apiKey: '!cat /run/secret', models: [{ id: 'gpt-5.5' }] },
        }),
      })
      harness.start()
      await settle()

      expect(Object.keys(harness.registrations[0]?.config ?? {})).toEqual(['models'])
      expect(harness.registered()).toEqual([expect.objectContaining({ contextWindow: 400_000 }), unknown])
    })

    // A registered list replaces every model type, while Pi layers virtual models back over any list.
    it('carries image and classifier models through, and leaves virtual ones to Pi', async () => {
      const virtual = makeSnapshot({ id: 'auto', api: 'pi-virtual', baseUrl: '' })
      const harness = setup({
        registry: createRegistry({ models: [makeSnapshot({ id: 'gpt-5.5' }), virtual], others: [IMAGE_MODEL] }),
      })
      harness.start()
      await settle()

      expect(harness.registered().map(model => model.id)).toEqual(['gpt-5.5', 'gpt-5.5-mini'])
      expect(harness.registered()).toContain(IMAGE_MODEL)
    })

    // Pi falls back to `models[0]` and throws when it cannot resolve api or baseUrl, deleting the provider.
    it('pins api and baseUrl, and carries the fields Pi reads from the model', async () => {
      const model = makeSnapshot({
        headers: { 'x-relay': '1' },
        samplingParams: { top_p: 0.9 },
        promptCache: { short: 300 },
        inputLimits: { images: { maxPerMessage: 4 } },
      })
      const harness = setup({ registry: createRegistry({ models: [model] }) })
      harness.start()
      await settle()

      expect(harness.registered()[0]).toMatchObject({
        api: model.api,
        baseUrl: model.baseUrl,
        headers: model.headers,
        samplingParams: model.samplingParams,
        promptCache: model.promptCache,
        inputLimits: model.inputLimits,
      })
    })

    it('re-registers only once another extension has changed the list', async () => {
      const registry = createRegistry({ models: [makeSnapshot({ id: 'gpt-5.5' })] })
      const harness = setup({ registry })
      harness.start()
      await settle()
      harness.emit('before_agent_start')
      expect(harness.registrations).toHaveLength(1)

      registry.models = [...registry.models, makeSnapshot({ id: 'late-arrival' })]
      harness.emit('before_agent_start')
      expect(harness.registered(1).map(model => model.id)).toEqual(['gpt-5.5', 'late-arrival'])
    })

    it('releases its registration once the provider is no longer opted in', async () => {
      const registry = createRegistry()
      const harness = setup({ registry })
      harness.start()
      await settle()
      registry.registered = harness.registrations[0]?.config

      writeFile(configPath(), { providers: {} })
      harness.start()

      expect(harness.unregistered).toEqual(['relay'])
    })
  })

  describe('failures and timing', () => {
    it('survives Pi refusing a registration', async () => {
      const harness = setup()
      harness.pi.registerProvider = () => {
        throw new Error('nope')
      }
      harness.start()
      await settle()

      expect(harness.warnings()).toContain("failed to complete provider 'relay': nope")
    })

    it('registers nothing rather than a partial completion when no catalog is available', async () => {
      const harness = setup({ fetch: () => new Response('', { status: 503 }) })
      harness.start()
      await settle()

      expect(harness.registrations).toHaveLength(0)
    })

    // A contextWindow changing mid-turn can flip a compaction decision.
    it('defers a mid-turn swap to turn_end', async () => {
      const harness = setup({ config: { providers: { relay: {} }, applyOnIdleOnly: true }, isIdle: false })
      harness.start()
      await settle()
      expect(harness.registrations).toHaveLength(0)

      harness.emit('turn_end')
      expect(harness.registrations).toHaveLength(1)
    })

    it('aborts the in-flight refresh on shutdown and registers nothing after it', async () => {
      let release: (() => void) | undefined
      const harness = setup({
        fetch: async url =>
          new Promise(resolve => {
            release = () => resolve(json(url.includes('pi.dev') ? PI_DEV_PAYLOAD : {}))
          }),
      })
      harness.start()
      await new Promise(resolve => setTimeout(resolve, 0))

      harness.emit('session_shutdown')
      release?.()
      await settle()

      expect(harness.registrations).toHaveLength(0)
    })
  })
})
