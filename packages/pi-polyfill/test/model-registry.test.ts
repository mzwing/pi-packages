import type { Api, Provider } from '@earendil-works/pi-ai'
import { ModelRegistry } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import { getModelRegistryProvider } from '../src/model-registry.js'

function provider(id: string): Provider<Api> {
  return {
    id,
    name: id,
    auth: {},
    getModels: () => [],
  } as unknown as Provider<Api>
}

describe('getModelRegistryProvider', () => {
  it('polyfills the Pi 0.80.10 ModelRegistry through its model runtime', () => {
    const expected = provider('legacy')
    const runtime = { getProvider: vi.fn() }
    runtime.getProvider.mockImplementation(function (this: object, providerId: string) {
      expect(this).toBe(runtime)
      return providerId === expected.id ? expected : undefined
    })
    const registry = new ModelRegistry(runtime as never)
    const keysBefore = Reflect.ownKeys(registry)

    expect('getProvider' in registry).toBe(false)
    expect(getModelRegistryProvider(registry, 'legacy')).toBe(expected)
    expect(getModelRegistryProvider(registry, 'missing')).toBeUndefined()
    expect(Reflect.ownKeys(registry)).toEqual(keysBefore)
    expect('getProvider' in registry).toBe(false)
  })

  it('prefers the native method and preserves its receiver', () => {
    const expected = provider('native')
    const legacyGetProvider = vi.fn(() => {
      throw new Error('legacy lookup should not run')
    })
    const registry = {
      getProvider(this: object, providerId: string) {
        expect(this).toBe(registry)
        return providerId === expected.id ? expected : undefined
      },
      runtime: { getProvider: legacyGetProvider },
    } as unknown as ModelRegistry

    expect(getModelRegistryProvider(registry, 'native')).toBe(expected)
    expect(legacyGetProvider).not.toHaveBeenCalled()
  })

  it('returns undefined when neither lookup is available', () => {
    expect(getModelRegistryProvider({} as ModelRegistry, 'missing')).toBeUndefined()
    expect(
      getModelRegistryProvider({ runtime: { getProvider: 'not-a-function' } } as unknown as ModelRegistry, 'missing'),
    ).toBeUndefined()
  })

  it('preserves errors from available native and legacy implementations', () => {
    const nativeError = new Error('native failed')
    const nativeRegistry = {
      getProvider: () => {
        throw nativeError
      },
      runtime: { getProvider: vi.fn() },
    } as unknown as ModelRegistry
    expect(() => getModelRegistryProvider(nativeRegistry, 'native')).toThrow(nativeError)

    const legacyError = new Error('legacy failed')
    const legacyRegistry = new ModelRegistry({
      getProvider: () => {
        throw legacyError
      },
    } as never)
    expect(() => getModelRegistryProvider(legacyRegistry, 'legacy')).toThrow(legacyError)
  })
})
