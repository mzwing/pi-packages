import type { Provider } from '@earendil-works/pi-ai'
import type { ModelRegistry } from '@earendil-works/pi-coding-agent'

interface ProviderLookup {
  getProvider: (providerId: string) => Provider | undefined
}

interface LegacyModelRegistry {
  readonly runtime?: unknown
}

function hasProviderLookup(value: unknown): value is ProviderLookup {
  return (
    typeof value === 'object' && value !== null && 'getProvider' in value && typeof value.getProvider === 'function'
  )
}

export function getModelRegistryProvider(registry: ModelRegistry, providerId: string): Provider | undefined {
  if (hasProviderLookup(registry)) {
    return registry.getProvider(providerId)
  }

  const runtime = (registry as unknown as LegacyModelRegistry).runtime
  if (!hasProviderLookup(runtime)) {
    return undefined
  }
  return runtime.getProvider(providerId)
}
