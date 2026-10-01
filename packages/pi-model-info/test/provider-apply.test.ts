import type { CatalogSnapshot } from '../src/catalog.js'
import type { SnapshotModel } from '../src/types.js'
import type { Provider } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ModelRegistry } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import { ProviderApplier } from '../src/provider-apply.js'
import { makeConfig, makeIndex, makeProvider, makeSnapshot, useWorkspace } from './helpers.js'

const CATALOG: CatalogSnapshot = {
  index: makeIndex([{ id: 'openai/gpt-5.5', contextWindow: 400_000 }]),
  status: 'ready',
  sources: [],
}

describe('a provider completed on read', () => {
  useWorkspace()

  /** A dynamic provider nothing else registered for, which the applier therefore wraps. */
  function wrap(models: SnapshotModel[], others?: unknown[], catalog = CATALOG): Provider {
    const base = {
      id: 'relay',
      getModels: () => models,
      ...(others === undefined ? {} : { getAllModels: () => [...models, ...others] }),
      refreshModels: async () => {},
    }
    const registry = {
      getProvider: () => base,
      getRegisteredNativeProvider: () => undefined,
      getRegisteredProviderConfig: () => undefined,
    } as unknown as ModelRegistry
    let wrapper: Provider | undefined
    const pi = {
      registerProvider: (provider: Provider) => {
        wrapper = provider
      },
    } as unknown as ExtensionAPI
    const applier = new ProviderApplier(pi)
    applier.capture(registry, makeConfig({ providers: new Map([['relay', makeProvider()]]) }))
    applier.apply(catalog)

    return wrapper!
  }

  it('keeps everything Pi carries on a model that a registration shape cannot express', () => {
    const model = { ...makeSnapshot({ id: 'gpt-5.5' }), provider: 'relay' } as SnapshotModel

    expect(wrap([model]).getModels()[0]).toMatchObject({ provider: 'relay', contextWindow: 400_000 })
  })

  // Pi's typed reads, `getModelsOfType()` and `getAllAvailable()` among them, list through `getAllModels`.
  it('lists the same completion through getAllModels, next to the models it never completes', () => {
    const image = { id: 'gpt-5.5', type: 'image', api: 'openrouter-images' }
    const wrapper = wrap([makeSnapshot({ id: 'gpt-5.5' })], [image])
    const [chat] = wrapper.getModels()

    expect(chat?.contextWindow).toBe(400_000)
    expect(wrapper.getAllModels?.()).toEqual([chat, image])
    expect('getAllModels' in wrap([makeSnapshot()])).toBe(false)
  })

  // Pi treats a throwing getModels() as a provider with no models, which would empty the picker.
  it('falls back to the base list rather than throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = { status: 'ready', sources: [] } as unknown as CatalogSnapshot

    expect(wrap([makeSnapshot({ id: 'gpt-5.5' })], undefined, broken).getModels()[0]?.contextWindow).toBe(128_000)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("completing 'relay' failed"))
    warn.mockRestore()
  })
})
