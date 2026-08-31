import type { CatalogSnapshot } from '../src/catalog.js'
import type { CompletionContext } from '../src/complete.js'
import type { SnapshotModel } from '../src/types.js'
import type { Provider } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { isOurWrapper, NativeWrap, unwrapProvider } from '../src/native-wrap.js'
import { makeConfig, makeIndex, makeProvider, makeSnapshot } from './helpers.js'

function base(models: SnapshotModel[]): Provider & { models: SnapshotModel[] } {
  const state = {
    id: 'relay',
    name: 'Relay',
    models,
    auth: {},
    getModels: () => state.models,
    refreshModels: async () => {},
    stream: () => {
      throw new Error('unused')
    },
    streamSimple: () => {
      throw new Error('unused')
    },
  }

  return state as unknown as Provider & { models: SnapshotModel[] }
}

function context(index = makeIndex([{ id: 'openai/gpt-5.5', contextWindow: 400_000 }])): CompletionContext {
  const catalog: CatalogSnapshot = { index, status: 'ready', sources: [] }

  return { config: makeConfig(), provider: makeProvider(), catalog, authored: undefined }
}

describe('a wrapped provider', () => {
  it('completes on every read, over whatever the base holds at that moment', () => {
    const pristine = base([makeSnapshot({ id: 'gpt-5.5' })])
    const wrapper = new NativeWrap(pristine, { context: () => context(), onReports: () => {}, warn: () => {} })

    expect(wrapper.provider.getModels()[0]?.contextWindow).toBe(400_000)

    pristine.models = [makeSnapshot({ id: 'gpt-5.5' }), makeSnapshot({ id: 'later' })]
    expect(wrapper.provider.getModels().map(model => model.id)).toEqual(['gpt-5.5', 'later'])
  })

  it('keeps everything Pi carries that a registration shape cannot express', () => {
    const pristine = base([{ ...makeSnapshot({ id: 'gpt-5.5' }), provider: 'relay' } as SnapshotModel])
    const wrapper = new NativeWrap(pristine, { context: () => context(), onReports: () => {}, warn: () => {} })

    expect(wrapper.provider.getModels()[0]).toMatchObject({ provider: 'relay', contextWindow: 400_000 })
  })

  it('hands back the base list while no catalog is loaded', () => {
    const pristine = base([makeSnapshot({ id: 'gpt-5.5' })])
    const wrapper = new NativeWrap(pristine, { context: () => undefined, onReports: () => {}, warn: () => {} })

    expect(wrapper.provider.getModels()[0]?.contextWindow).toBe(128_000)
  })

  // Pi treats a throwing getModels() as a provider with no models, which would empty the picker.
  it('falls back to the base list rather than throwing', () => {
    const warnings: string[] = []
    const pristine = base([makeSnapshot({ id: 'gpt-5.5' })])
    const wrapper = new NativeWrap(pristine, {
      context: () => ({ ...context(), catalog: { status: 'ready', sources: [] } as unknown as CatalogSnapshot }),
      onReports: () => {},
      warn: message => warnings.push(message),
    })

    expect(wrapper.provider.getModels()[0]?.contextWindow).toBe(128_000)
    expect(warnings.join('\n')).toContain("completing 'relay' failed")
  })

  it('is recognisable and unwrappable, so a second pass reads the base', () => {
    const pristine = base([makeSnapshot()])
    const wrapper = new NativeWrap(pristine, { context: () => undefined, onReports: () => {}, warn: () => {} })

    expect(isOurWrapper(wrapper.provider)).toBe(true)
    expect(isOurWrapper(pristine)).toBe(false)
    expect(isOurWrapper(undefined)).toBe(false)
    expect(unwrapProvider(wrapper.provider)).toBe(pristine)
    expect(unwrapProvider(pristine)).toBe(pristine)
  })
})
