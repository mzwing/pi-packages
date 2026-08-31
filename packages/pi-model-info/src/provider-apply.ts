import type { CatalogSnapshot } from './catalog.js'
import type { CompletionContext, ModelReport } from './complete.js'
import type { EnrichedModel } from './merge.js'
import type { UserAuthoredMap } from './models-json.js'
import type { ResolvedConfig, ResolvedProvider, SnapshotModel } from './types.js'
import type { Api, Provider } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ModelRegistry, ProviderConfig, ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import { completeModel } from './complete.js'
import { isOurWrapper, NativeWrap, unwrapProvider } from './native-wrap.js'

export type { ModelReport } from './complete.js'

/**
 * How a provider is completed, decided once per session from what Pi and its siblings already hold.
 *
 * - `native`  — the list is wrapped and completed on every read, so it never freezes.
 * - `decorate` — a sibling's `refreshModels` is wrapped, so each refresh returns a completed list.
 * - `replace` — the list is snapshotted and re-registered; the only option when we do not own the
 *   slot, and the one that freezes a dynamic list for the session.
 */
export type ProviderStrategy = 'native' | 'decorate' | 'replace'

export interface ProviderReport {
  provider: string
  status: 'applied' | 'skipped' | 'failed' | 'pending'
  strategy?: ProviderStrategy | undefined
  reason: string | undefined
  models: ModelReport[]
}

export interface ProviderApplierDeps {
  warn?: ((message: string) => void) | undefined
}

type RefreshModels = NonNullable<ProviderConfig['refreshModels']>
type RefreshContext = Parameters<RefreshModels>[0]

/** Pi declares `refreshModels` as a method; read through a plain property so it stays a value. */
interface RefreshCapable {
  refreshModels?: RefreshModels | undefined
}

/** Global, like the provider marker: a `/reload` must not let us decorate our own decorator. */
const DECORATED = Symbol.for('@mzwing/pi-model-info.refresh-decorator')

interface Decorated {
  [DECORATED]: RefreshModels
}

interface Tracked {
  provider: ResolvedProvider
  strategy: ProviderStrategy
  /** `decorate` / `replace`: the list as Pi held it before our registration shadowed it. */
  snapshot: SnapshotModel[]
  /** `decorate`: the wrapper handed to Pi, built once so re-applying does not churn it. */
  refresh: RefreshModels | undefined
  /** `decorate`: provider-level fallbacks for a definition that omits them. */
  api: Api | undefined
  baseUrl: string | undefined
}

interface Applied {
  config: ResolvedConfig
  catalog: CatalogSnapshot
  authored: UserAuthoredMap
}

interface CompletedList {
  models: EnrichedModel[]
  reports: ModelReport[]
}

export class ProviderApplier {
  private readonly tracked = new Map<string, Tracked>()
  private readonly skipped = new Map<string, string>()
  private readonly reports = new Map<string, ProviderReport>()
  private readonly lastRegistered = new Map<string, EnrichedModel[]>()
  /** Outlives `capture`, so a `/reload` reuses one wrapper per provider instead of nesting them. */
  private readonly wraps = new Map<string, NativeWrap>()
  /** Provider to the catalog fingerprint it was last registered with, to skip a no-op re-register. */
  private readonly appliedCatalog = new Map<string, string>()
  private readonly warn: (message: string) => void
  private applied: Applied | undefined

  constructor(deps: ProviderApplierDeps = {}) {
    this.warn = deps.warn ?? (() => {})
  }

  /**
   * Chooses a strategy per provider, and for the two registration strategies takes the list as Pi
   * has it now: afterwards `getProvider(id).getModels()` returns our own, and re-deriving from it
   * would fold every previous pass into the next one.
   */
  capture(registry: ModelRegistry, config: ResolvedConfig, authored: UserAuthoredMap): void {
    this.tracked.clear()
    this.skipped.clear()
    this.reports.clear()
    // The config may have changed under a `/reload`, so every wrapper owes Pi one fresh pass.
    this.appliedCatalog.clear()

    for (const provider of config.providers.values()) {
      const live = registry.getProvider(provider.id)
      if (live === undefined) {
        this.skip(provider.id, 'not present in Pi; check the provider id')
        continue
      }

      const native = registry.getRegisteredNativeProvider(provider.id)
      if (native !== undefined && !isOurWrapper(native)) {
        // registerProvider drops the native registration, so we would delete it.
        this.skip(provider.id, 'another extension registered a native provider for this id')
        continue
      }
      // Once our own wrapper is in place it is the outermost layer Pi hands back, so a second pass
      // has to re-derive from what it wraps rather than from its output.
      const pristine = native === undefined ? live : unwrapProvider(native)
      const registered = registry.getRegisteredProviderConfig(provider.id)

      if (registered === undefined && pristine.refreshModels !== undefined && !authored.has(provider.id)) {
        this.trackNative(provider, pristine)
        continue
      }

      const snapshot = [...pristine.getModels()] as SnapshotModel[]
      if (snapshot.length === 0) {
        this.skip(provider.id, 'no models to complete')
        continue
      }

      const sibling = undecorate((registered as RefreshCapable | undefined)?.refreshModels)
      if (sibling !== undefined) {
        this.track(provider, 'decorate', snapshot, {
          refresh: this.decorate(provider.id, sibling),
          api: registered?.api,
          baseUrl: registered?.baseUrl,
        })
        continue
      }

      if (pristine.refreshModels !== undefined && !provider.allowDynamic) {
        this.warn(
          `provider '${provider.id}' refreshes its model list dynamically, but ${
            registered === undefined ? 'models.json defines models for it' : 'another extension owns its registration'
          }, so completing it freezes newly discovered models until the next session`,
        )
      }
      this.track(provider, 'replace', snapshot, {})
    }
  }

  apply(pi: ExtensionAPI, config: ResolvedConfig, catalog: CatalogSnapshot, userAuthored: UserAuthoredMap): void {
    if (catalog.status === 'unavailable') {
      return
    }
    this.applied = { config, catalog, authored: userAuthored }

    for (const [providerId, tracked] of this.tracked) {
      if (tracked.strategy === 'native') {
        this.applyNative(pi, providerId)
      } else {
        this.applyRegistration(pi, providerId, tracked)
      }
    }
  }

  /**
   * Cheap id-set comparison against the live list, for the strategies that snapshot one. `native`
   * re-reads on every access and `decorate` completes inside the refresh, so neither can drift.
   */
  reconcile(registry: ModelRegistry): boolean {
    let drifted = false
    for (const [providerId, tracked] of this.tracked) {
      if (tracked.strategy === 'native') {
        continue
      }
      const live = registry.getProvider(providerId)
      if (live === undefined) {
        continue
      }
      const liveModels = [...live.getModels()] as SnapshotModel[]
      const registered = this.lastRegistered.get(providerId)
      if (liveModels.length === 0 || (registered !== undefined && sameIds(liveModels, registered))) {
        continue
      }
      tracked.snapshot = liveModels
      drifted = true
    }

    return drifted
  }

  /**
   * Registrations outlive a `/reload` while our in-memory state does not, so one left behind for a
   * provider that is no longer opted in would linger and could make a later recompose delete the
   * provider outright.
   */
  releaseStale(pi: ExtensionAPI, registry: ModelRegistry, config: ResolvedConfig): void {
    for (const providerId of [...this.wraps.keys()]) {
      if (config.providers.has(providerId)) {
        continue
      }
      if (!isOurWrapper(registry.getRegisteredNativeProvider(providerId))) {
        this.wraps.delete(providerId)
        continue
      }
      // unregisterProvider drops the whole entry, so it is only safe while ours is the only one.
      if (registry.getRegisteredProviderConfig(providerId) !== undefined) {
        continue
      }
      this.release(pi, providerId)
    }

    for (const [providerId, models] of this.lastRegistered) {
      if (config.providers.has(providerId)) {
        continue
      }
      // unregisterProvider drops the whole entry, including another extension's baseUrl and apiKey.
      // Leaving ours in place is the lesser harm.
      if (!isSolelyOurRegistration(registry.getRegisteredProviderConfig(providerId), models)) {
        continue
      }
      this.release(pi, providerId)
    }
  }

  getReports(): ProviderReport[] {
    const reports = [...this.reports.values()]
    for (const [provider, reason] of this.skipped) {
      reports.push({ provider, status: 'skipped', reason, models: [] })
    }

    return reports.sort((a, b) => a.provider.localeCompare(b.provider))
  }

  // ── Strategy selection ──────────────────────────────────────────────────────

  private track(
    provider: ResolvedProvider,
    strategy: ProviderStrategy,
    snapshot: SnapshotModel[],
    extra: { refresh?: RefreshModels | undefined; api?: Api | undefined; baseUrl?: string | undefined },
  ): void {
    this.tracked.set(provider.id, {
      provider,
      strategy,
      snapshot,
      refresh: extra.refresh,
      api: extra.api,
      baseUrl: extra.baseUrl,
    })
    this.reports.set(provider.id, {
      provider: provider.id,
      status: 'pending',
      strategy,
      reason: undefined,
      models: [],
    })
  }

  private trackNative(provider: ResolvedProvider, pristine: Provider): void {
    this.track(provider, 'native', [], {})

    const existing = this.wraps.get(provider.id)
    if (existing?.pristine === pristine) {
      return
    }
    this.wraps.set(
      provider.id,
      new NativeWrap(pristine, {
        context: () => this.nativeContext(provider.id),
        onReports: reports => {
          this.recordNative(provider.id, reports)
        },
        warn: this.warn,
      }),
    )
  }

  /** `undefined` keeps a wrapper inert: it hands back the list underneath, uncompleted. */
  private nativeContext(providerId: string): CompletionContext | undefined {
    const applied = this.applied
    const tracked = this.tracked.get(providerId)
    if (applied === undefined || tracked?.strategy !== 'native') {
      return undefined
    }

    return {
      config: applied.config,
      provider: tracked.provider,
      catalog: applied.catalog,
      authored: applied.authored.get(providerId),
    }
  }

  private recordNative(providerId: string, models: ModelReport[]): void {
    if (this.tracked.get(providerId)?.strategy !== 'native') {
      return
    }
    this.reports.set(providerId, {
      provider: providerId,
      status: 'applied',
      strategy: 'native',
      reason: undefined,
      models,
    })
  }

  // ── Application ─────────────────────────────────────────────────────────────

  private applyNative(pi: ExtensionAPI, providerId: string): void {
    const wrap = this.wraps.get(providerId)
    const applied = this.applied
    if (wrap === undefined || applied === undefined) {
      return
    }
    // Registering rebuilds Pi's whole model snapshot, so a catalog that says the same thing as the
    // one already in force buys nothing.
    const fingerprint = catalogFingerprint(applied.catalog)
    if (this.appliedCatalog.get(providerId) === fingerprint) {
      return
    }
    wrap.invalidate()
    try {
      // Registering the object rather than a config makes it Pi's base for this provider, so its
      // `getModels()` is the last word and nothing replaces the list wholesale.
      pi.registerProvider(wrap.provider)
      this.appliedCatalog.set(providerId, fingerprint)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.warn(`failed to complete provider '${providerId}': ${message}`)
      this.reports.set(providerId, {
        provider: providerId,
        status: 'failed',
        strategy: 'native',
        reason: message,
        models: [],
      })
    }
  }

  private applyRegistration(pi: ExtensionAPI, providerId: string, tracked: Tracked): void {
    const completed = this.complete(tracked, tracked.snapshot)
    if (completed === undefined) {
      return
    }

    try {
      // `models` plus, for a sibling that refreshes, the hook that keeps the completion alive.
      // Nothing else: registerProvider merges defined keys and never expires them, so any other key
      // would permanently shadow the sibling's — and a relay's apiKey usually lives there.
      const config: ProviderConfig =
        tracked.refresh === undefined
          ? { models: completed.models }
          : { models: completed.models, refreshModels: tracked.refresh }
      pi.registerProvider(providerId, config)
      this.lastRegistered.set(providerId, completed.models)
      this.reports.set(providerId, {
        provider: providerId,
        status: 'applied',
        strategy: tracked.strategy,
        reason: undefined,
        models: completed.reports,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.warn(`failed to complete provider '${providerId}': ${message}`)
      this.reports.set(providerId, {
        provider: providerId,
        status: 'failed',
        strategy: tracked.strategy,
        reason: message,
        models: completed.reports,
      })
    }
  }

  /**
   * Wraps a sibling's own hook so the completion runs inside Pi's refresh: what the sibling returns
   * is the clean upstream list, and what we return is what `/model` renders once the refresh lands.
   */
  private decorate(providerId: string, original: RefreshModels): RefreshModels {
    const decorator = async (context: RefreshContext): Promise<ProviderModelConfig[]> => {
      const fresh = await original(context)
      const tracked = this.tracked.get(providerId)
      if (tracked === undefined || !Array.isArray(fresh) || fresh.length === 0) {
        return fresh
      }
      const snapshot = fresh
        .map(definition => toSnapshot(definition, tracked.api, tracked.baseUrl))
        .filter((model): model is SnapshotModel => model !== undefined)
      const completed = this.complete(tracked, snapshot)
      if (completed === undefined) {
        return fresh
      }
      tracked.snapshot = snapshot

      // A definition we could not type stays exactly as the sibling wrote it, in place.
      const byId = new Map(completed.models.map(model => [model.id, model]))
      const models: ProviderModelConfig[] = fresh.map(definition => byId.get(definition.id) ?? definition)
      this.lastRegistered.set(providerId, models)
      this.reports.set(providerId, {
        provider: providerId,
        status: 'applied',
        strategy: 'decorate',
        reason: undefined,
        models: completed.reports,
      })

      return models
    }
    const marked = decorator as typeof decorator & Decorated
    marked[DECORATED] = original

    return marked
  }

  /** `undefined` until a catalog is loaded. */
  private complete(tracked: Tracked, snapshots: readonly SnapshotModel[]): CompletedList | undefined {
    const applied = this.applied
    if (applied === undefined) {
      return undefined
    }
    const context: CompletionContext = {
      config: applied.config,
      provider: tracked.provider,
      catalog: applied.catalog,
      authored: applied.authored.get(tracked.provider.id),
    }

    const models: EnrichedModel[] = []
    const reports: ModelReport[] = []

    // Every model, always: a registration replaces the list wholesale, so anything omitted here
    // disappears from Pi.
    for (const snapshot of snapshots) {
      const completion = completeModel(snapshot, context)
      models.push(completion.model)
      reports.push(completion.report)
    }

    return { models, reports }
  }

  private release(pi: ExtensionAPI, providerId: string): void {
    try {
      pi.unregisterProvider(providerId)
      this.lastRegistered.delete(providerId)
      this.wraps.delete(providerId)
      this.appliedCatalog.delete(providerId)
    } catch (error) {
      this.warn(`failed to release provider '${providerId}': ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private skip(providerId: string, reason: string): void {
    this.skipped.set(providerId, reason)
    this.warn(`skipping provider '${providerId}': ${reason}`)
  }
}

function catalogFingerprint(catalog: CatalogSnapshot): string {
  return catalog.sources.map(source => `${source.source}@${source.fetchedAt ?? 0}#${source.entryCount}`).join('|')
}

function undecorate(refresh: RefreshModels | undefined): RefreshModels | undefined {
  return refresh === undefined ? undefined : ((refresh as Partial<Decorated>)[DECORATED] ?? refresh)
}

/** A registration definition may lean on the provider for `api` and `baseUrl`; a snapshot may not. */
function toSnapshot(
  definition: ProviderModelConfig,
  api: Api | undefined,
  baseUrl: string | undefined,
): SnapshotModel | undefined {
  const resolvedApi = definition.api ?? api
  const resolvedBaseUrl = definition.baseUrl ?? baseUrl
  if (resolvedApi === undefined || resolvedBaseUrl === undefined) {
    return undefined
  }

  return { ...definition, api: resolvedApi, baseUrl: resolvedBaseUrl }
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
