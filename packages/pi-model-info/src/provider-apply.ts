import type { CatalogSnapshot } from './catalog.js'
import type { EnrichedModel } from './merge.js'
import type { UserAuthoredMap } from './models-json.js'
import type { Resolution, ResolvedConfig, ResolvedProvider, SnapshotModel } from './types.js'
import type { ExtensionAPI, ModelRegistry } from '@earendil-works/pi-coding-agent'
import { mergeMetadata } from './merge.js'
import { resolveModel } from './resolver.js'

export interface ModelReport {
  id: string
  resolution: Resolution
  provenance: Map<string, string>
  issues: string[]
  model: EnrichedModel
}

export interface ProviderReport {
  provider: string
  status: 'applied' | 'skipped' | 'failed' | 'pending'
  reason: string | undefined
  models: ModelReport[]
}

export interface ProviderApplierDeps {
  warn?: ((message: string) => void) | undefined
}

export class ProviderApplier {
  private readonly snapshots = new Map<string, SnapshotModel[]>()
  private readonly skipped = new Map<string, string>()
  private readonly reports = new Map<string, ProviderReport>()
  private readonly lastRegistered = new Map<string, EnrichedModel[]>()
  private readonly warn: (message: string) => void

  constructor(deps: ProviderApplierDeps = {}) {
    this.warn = deps.warn ?? (() => {})
  }

  /**
   * Must run before the first registration of the session: afterwards `getProvider(id).getModels()`
   * returns our own list, and re-deriving from it would fold every previous pass into the next one.
   */
  capture(registry: ModelRegistry, config: ResolvedConfig): void {
    this.snapshots.clear()
    this.skipped.clear()
    this.reports.clear()

    for (const provider of config.providers.values()) {
      const live = registry.getProvider(provider.id)
      if (live === undefined) {
        this.skip(provider.id, 'not present in Pi; check the provider id')
        continue
      }
      if (registry.getRegisteredNativeProvider(provider.id) !== undefined) {
        // registerProvider drops the native registration, so we would delete it.
        this.skip(provider.id, 'another extension registered a native provider for this id')
        continue
      }

      const snapshot = [...live.getModels()]
      if (snapshot.length === 0) {
        this.skip(provider.id, 'no models to complete')
        continue
      }
      if (live.refreshModels !== undefined && !provider.allowDynamic) {
        this.warn(
          `provider '${provider.id}' refreshes its model list dynamically; completing it freezes ` +
            'newly discovered models until the next session',
        )
      }

      this.snapshots.set(provider.id, snapshot)
      this.reports.set(provider.id, { provider: provider.id, status: 'pending', reason: undefined, models: [] })
    }
  }

  apply(pi: ExtensionAPI, config: ResolvedConfig, catalog: CatalogSnapshot, userAuthored: UserAuthoredMap): void {
    if (catalog.status === 'unavailable') {
      return
    }

    for (const [providerId, snapshot] of this.snapshots) {
      const provider = config.providers.get(providerId)
      if (provider !== undefined) {
        this.applyProvider(pi, provider, snapshot, config, catalog, userAuthored)
      }
    }
  }

  private applyProvider(
    pi: ExtensionAPI,
    provider: ResolvedProvider,
    snapshots: SnapshotModel[],
    config: ResolvedConfig,
    catalog: CatalogSnapshot,
    userAuthored: UserAuthoredMap,
  ): void {
    const authored = userAuthored.get(provider.id)
    const models: EnrichedModel[] = []
    const reports: ModelReport[] = []

    // Every model from the snapshot, always: `applyExtension` replaces the list wholesale, so
    // anything omitted here disappears from Pi.
    for (const snapshot of snapshots) {
      const resolution = resolveModel({
        index: catalog.index,
        provider,
        prefixRules: config.prefixRules,
        suffixRules: config.suffixRules,
        modelId: snapshot.id,
      })
      const merged = mergeMetadata({
        snapshot,
        provider,
        resolution,
        gate: provider.models.get(snapshot.id),
        userAuthored: authored?.get(snapshot.id),
      })
      models.push(merged.model)
      reports.push({
        id: snapshot.id,
        resolution,
        provenance: merged.provenance,
        issues: merged.issues,
        model: merged.model,
      })
    }

    try {
      // Exactly `{ models }`: registerProvider merges defined keys and never expires them, so any
      // other key would permanently shadow a sibling extension's — and a relay's apiKey usually
      // lives in that sibling's registration.
      pi.registerProvider(provider.id, { models })
      this.lastRegistered.set(provider.id, models)
      this.reports.set(provider.id, { provider: provider.id, status: 'applied', reason: undefined, models: reports })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.warn(`failed to complete provider '${provider.id}': ${message}`)
      this.reports.set(provider.id, { provider: provider.id, status: 'failed', reason: message, models: reports })
    }
  }

  /**
   * Cheap id-set comparison against the live list. Ordering already guarantees a discovery extension
   * registers before our first pass, so this only catches a third party changing the list mid-session.
   */
  reconcile(registry: ModelRegistry): boolean {
    let drifted = false
    for (const providerId of this.snapshots.keys()) {
      const live = registry.getProvider(providerId)
      if (live === undefined) {
        continue
      }
      const liveModels = [...live.getModels()]
      const registered = this.lastRegistered.get(providerId)
      if (liveModels.length === 0 || (registered !== undefined && sameIds(liveModels, registered))) {
        continue
      }
      this.snapshots.set(providerId, liveModels)
      drifted = true
    }

    return drifted
  }

  /**
   * `extensionProviders` outlives a `/reload` while our in-memory state does not, so a registration
   * for a provider that is no longer opted in would linger and could make a later recompose delete
   * the provider outright.
   */
  releaseStale(pi: ExtensionAPI, registry: ModelRegistry, config: ResolvedConfig): void {
    for (const [providerId, models] of this.lastRegistered) {
      if (config.providers.has(providerId)) {
        continue
      }
      // unregisterProvider drops the whole entry, including another extension's baseUrl and apiKey.
      // Leaving ours in place is the lesser harm.
      if (!isSolelyOurRegistration(registry.getRegisteredProviderConfig(providerId), models)) {
        continue
      }
      try {
        pi.unregisterProvider(providerId)
        this.lastRegistered.delete(providerId)
      } catch (error) {
        this.warn(
          `failed to release provider '${providerId}': ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  getReports(): ProviderReport[] {
    const reports = [...this.reports.values()]
    for (const [provider, reason] of this.skipped) {
      reports.push({ provider, status: 'skipped', reason, models: [] })
    }

    return reports.sort((a, b) => a.provider.localeCompare(b.provider))
  }

  private skip(providerId: string, reason: string): void {
    this.skipped.set(providerId, reason)
    this.warn(`skipping provider '${providerId}': ${reason}`)
  }
}

function sameIds(live: readonly SnapshotModel[], registered: readonly EnrichedModel[]): boolean {
  if (live.length !== registered.length) {
    return false
  }
  const ids = new Set(registered.map(model => model.id))

  return live.every(model => ids.has(model.id))
}

function isSolelyOurRegistration(stored: object | undefined, models: EnrichedModel[]): boolean {
  if (stored === undefined) {
    return false
  }
  const keys = Object.keys(stored)

  return keys.length === 1 && keys[0] === 'models' && (stored as { models?: unknown }).models === models
}
