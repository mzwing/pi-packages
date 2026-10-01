import type { CatalogSnapshot } from './catalog.js'
import type { UserAuthoredMap } from './models-json.js'
import type { ChatModelConfig, Resolution, ResolvedConfig, ResolvedProvider, SnapshotModel } from './types.js'
import type { AnyModel, Api, Model, Provider } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ModelRegistry, ProviderConfig, ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import { mergeMetadata } from './merge.js'
import { readUserAuthoredFields } from './models-json.js'
import { resolveModel } from './resolver.js'
import { describeError, warn } from './util.js'

// Global, so a `/reload`, which loads a fresh module instance, still recognises what an earlier one installed.
const WRAPPED = Symbol.for('@mzwing/pi-model-info.wrapped-provider')
const DECORATED = Symbol.for('@mzwing/pi-model-info.refresh-decorator')

/** Pi keys virtual models on this api but does not export its `isVirtualModel`. */
const VIRTUAL_API = 'pi-virtual'

type PiModel = Model<Api>
type RefreshModels = NonNullable<ProviderConfig['refreshModels']>

/**
 * How a provider is completed, chosen per session from what Pi and its siblings already hold.
 *
 * - `native`: the list is wrapped and completed on every read, so it never freezes.
 * - `decorate`: a sibling's `refreshModels` is wrapped, so each refresh returns a completed list.
 * - `replace`: the list is snapshotted and re-registered, which freezes a dynamic list for the session; the only
 *   option when something else owns the registration slot.
 */
export type ProviderStrategy = 'native' | 'decorate' | 'replace'

export interface ModelReport {
  id: string
  resolution: Resolution
  provenance: Map<string, string>
  model: ChatModelConfig
}

export interface ProviderReport {
  provider: string
  status: 'applied' | 'skipped' | 'failed' | 'pending'
  strategy?: ProviderStrategy | undefined
  reason: string | undefined
  models: ModelReport[]
}

interface Tracked {
  provider: ResolvedProvider
  strategy: ProviderStrategy
  /** The list as Pi held it before a registration shadowed it. */
  snapshot: SnapshotModel[]
  /** Entries never completed, which a registered list has to carry along. */
  others: ProviderModelConfig[]
  /** `decorate`: the hook handed to Pi, built once so re-applying does not churn it. */
  refresh?: RefreshModels | undefined
  /** `decorate`: provider-level fallbacks for a definition that omits them. */
  api?: Api | undefined
  baseUrl?: string | undefined
}

interface Wrapped {
  [WRAPPED]: Provider
}

interface Decorated {
  [DECORATED]: RefreshModels
}

/** Pi declares `refreshModels` as a method; reading it as a property keeps it a value. */
interface RefreshCapable {
  refreshModels?: RefreshModels | undefined
}

/** An entry without `type` is chat, as Pi reads it. */
function isChat<T extends { type?: string | undefined }>(model: T): model is Extract<T, { type?: 'chat' }> {
  return (model.type ?? 'chat') === 'chat'
}

/** A virtual model only routes to physical ones, and Pi layers the registered ones back over any list. */
function chatModels(provider: Provider): PiModel[] {
  return provider.getModels().filter(model => model.api !== VIRTUAL_API)
}

/** A registered list replaces every model type, so image and classifier models ride along untouched. */
function passthroughModels(provider: Provider): AnyModel[] {
  return (provider.getAllModels?.() ?? []).filter(model => !isChat(model))
}

/** A registration definition may lean on the provider for `api` and `baseUrl`; a snapshot may not. */
function toSnapshot(
  definition: ProviderModelConfig,
  api: Api | undefined,
  baseUrl: string | undefined,
): SnapshotModel | undefined {
  if (!isChat(definition)) {
    return undefined
  }
  const resolvedApi = definition.api ?? api
  const resolvedBaseUrl = definition.baseUrl ?? baseUrl

  return resolvedApi === undefined || resolvedBaseUrl === undefined
    ? undefined
    : { ...definition, api: resolvedApi, baseUrl: resolvedBaseUrl }
}

function sameIds(live: readonly SnapshotModel[], registered: readonly ProviderModelConfig[]): boolean {
  const chat = registered.filter(model => isChat(model))
  const ids = new Set(chat.map(model => model.id))

  return live.length === chat.length && live.every(model => ids.has(model.id))
}

function isSolelyOurs(stored: object | undefined, models: ProviderModelConfig[]): boolean {
  return stored !== undefined && Object.keys(stored).length === 1 && (stored as { models?: unknown }).models === models
}

export class ProviderApplier {
  private readonly pi: ExtensionAPI
  private readonly tracked = new Map<string, Tracked>()
  private readonly reports = new Map<string, ProviderReport>()
  private readonly lastRegistered = new Map<string, ProviderModelConfig[]>()
  /** Outlives `capture`, so a session switch reuses one wrapper per provider instead of nesting them. */
  private readonly wrappers = new Map<string, Provider & Wrapped>()
  /** The catalog each wrapper was last registered with; registering rebuilds Pi's whole model snapshot. */
  private readonly registeredCatalog = new Map<string, string>()
  private config: ResolvedConfig | undefined
  private authored: UserAuthoredMap = new Map()
  /** The catalog in force, which a wrapper reads at the moment Pi asks it for models. */
  private catalog: CatalogSnapshot | undefined

  constructor(pi: ExtensionAPI) {
    this.pi = pi
  }

  /**
   * Chooses a strategy per provider. The registration strategies take the list as Pi holds it now, because
   * afterwards `getProvider(id).getModels()` returns our own list and re-deriving from it would fold every pass
   * into the next.
   */
  capture(registry: ModelRegistry, config: ResolvedConfig): void {
    this.releaseStale(registry, config)
    this.config = config
    // Which models models.json defines decides the strategy, so it is read before any is chosen.
    this.authored = config.providers.size === 0 ? new Map() : readUserAuthoredFields()
    this.tracked.clear()
    this.reports.clear()
    // The config may have changed, so every wrapper owes Pi one fresh pass.
    this.registeredCatalog.clear()

    for (const provider of config.providers.values()) {
      this.captureOne(registry, provider)
    }
  }

  apply(catalog: CatalogSnapshot): void {
    if (catalog.status === 'unavailable') {
      return
    }
    this.catalog = catalog
    for (const [providerId, tracked] of this.tracked) {
      if (tracked.strategy === 'native') {
        this.applyNative(providerId, catalog)
      } else {
        this.applyRegistration(providerId, tracked)
      }
    }
  }

  /** Whether a list something else changed under a registration now differs from what was last registered. */
  reconcile(registry: ModelRegistry): boolean {
    let drifted = false
    for (const [providerId, tracked] of this.tracked) {
      const live = tracked.strategy === 'native' ? undefined : registry.getProvider(providerId)
      if (live === undefined) {
        continue
      }
      const liveModels = chatModels(live)
      const registered = this.lastRegistered.get(providerId)
      if (liveModels.length === 0 || (registered !== undefined && sameIds(liveModels, registered))) {
        continue
      }
      tracked.snapshot = liveModels
      tracked.others = passthroughModels(live)
      drifted = true
    }

    return drifted
  }

  getReports(): ProviderReport[] {
    return [...this.reports.values()].sort((left, right) => left.provider.localeCompare(right.provider))
  }

  private captureOne(registry: ModelRegistry, provider: ResolvedProvider): void {
    const live = registry.getProvider(provider.id)
    const native = registry.getRegisteredNativeProvider(provider.id)
    if (live === undefined) {
      this.skip(provider.id, 'not present in Pi; check the provider id')

      return
    }
    if (native !== undefined && !(WRAPPED in native)) {
      // registerProvider drops a native registration, so completing this provider would delete it.
      this.skip(provider.id, 'another extension registered a native provider for this id')

      return
    }
    // Our wrapper is the outermost layer Pi hands back, so a later pass re-derives from what it wraps.
    const pristine = native === undefined ? live : (native as Provider & Wrapped)[WRAPPED]
    const registered = registry.getRegisteredProviderConfig(provider.id)

    if (registered === undefined && pristine.refreshModels !== undefined && !this.authored.has(provider.id)) {
      this.track(provider, { strategy: 'native', snapshot: [], others: [] })
      if (this.wrappers.get(provider.id)?.[WRAPPED] !== pristine) {
        this.wrappers.set(provider.id, this.wrap(provider.id, pristine))
      }

      return
    }

    const snapshot = chatModels(pristine)
    if (snapshot.length === 0) {
      this.skip(provider.id, 'no models to complete')

      return
    }
    const others = passthroughModels(pristine)
    const siblingRefresh = (registered as RefreshCapable | undefined)?.refreshModels
    if (siblingRefresh !== undefined) {
      // After a `/reload` the sibling's slot holds our own decorator, which must not be decorated again.
      const original = (siblingRefresh as Partial<Decorated>)[DECORATED] ?? siblingRefresh
      this.track(provider, {
        strategy: 'decorate',
        snapshot,
        others,
        refresh: this.decorate(provider.id, original),
        api: registered?.api,
        baseUrl: registered?.baseUrl,
      })

      return
    }

    if (pristine.refreshModels !== undefined && !provider.allowDynamic) {
      warn(
        `provider '${provider.id}' refreshes its model list dynamically, but ${
          registered === undefined ? 'models.json defines models for it' : 'another extension owns its registration'
        }, so completing it freezes newly discovered models until the next session`,
      )
    }
    this.track(provider, { strategy: 'replace', snapshot, others })
  }

  private track(provider: ResolvedProvider, tracked: Omit<Tracked, 'provider'>): void {
    this.tracked.set(provider.id, { provider, ...tracked })
    this.reports.set(provider.id, {
      provider: provider.id,
      status: 'pending',
      strategy: tracked.strategy,
      reason: undefined,
      models: [],
    })
  }

  private skip(providerId: string, reason: string): void {
    this.reports.set(providerId, { provider: providerId, status: 'skipped', reason, models: [] })
    warn(`skipping provider '${providerId}': ${reason}`)
  }

  private fail(providerId: string, strategy: ProviderStrategy, error: unknown, models: ModelReport[]): void {
    const reason = describeError(error)
    warn(`failed to complete provider '${providerId}': ${reason}`)
    this.reports.set(providerId, { provider: providerId, status: 'failed', strategy, reason, models })
  }

  /** Only reachable once `capture` and `apply` have run; reads the catalog in force at this moment. */
  private complete(
    provider: ResolvedProvider,
    snapshot: SnapshotModel,
  ): { model: ChatModelConfig; report: ModelReport } {
    const config = this.config!
    const resolution = resolveModel({
      index: this.catalog!.index,
      provider,
      prefixRules: config.prefixRules,
      suffixRules: config.suffixRules,
      modelId: snapshot.id,
    })
    const { model, provenance } = mergeMetadata({
      snapshot,
      provider,
      resolution,
      userAuthored: this.authored.get(provider.id)?.get(snapshot.id),
    })

    return { model, report: { id: snapshot.id, resolution, provenance, model } }
  }

  /**
   * A provider whose `getModels()` completes the list underneath on every read, so whatever refreshes Pi's own
   * dynamic list in place shows new models already completed. Spreading the base is safe only because Pi's own
   * providers keep their state in closures, never on `this`.
   */
  private wrap(providerId: string, pristine: Provider): Provider & Wrapped {
    const completions = new WeakMap<PiModel, { catalog: CatalogSnapshot; model: PiModel; report: ModelReport }>()
    const getModels = (): PiModel[] => {
      const base = chatModels(pristine)
      const { catalog } = this
      const tracked = this.tracked.get(providerId)
      if (catalog === undefined || tracked?.strategy !== 'native') {
        return base
      }
      try {
        const completed = base.map(model => {
          const cached = completions.get(model)
          if (cached?.catalog === catalog) {
            return cached
          }
          const { model: completion, report } = this.complete(tracked.provider, model)
          // Spread over the original, so `provider` and whatever else a registration cannot express survives.
          const fresh = { catalog, model: { ...model, ...completion } as PiModel, report }
          completions.set(model, fresh)

          return fresh
        })
        this.reports.set(providerId, {
          provider: providerId,
          status: 'applied',
          strategy: 'native',
          reason: undefined,
          models: completed.map(entry => entry.report),
        })

        return completed.map(entry => entry.model)
      } catch (error) {
        // Pi treats a throwing `getModels()` as a provider with no models; the uncompleted list is the lesser harm.
        warn(`completing '${providerId}' failed: ${describeError(error)}`)

        return base
      }
    }

    const wrapper: Provider & Wrapped = { ...pristine, [WRAPPED]: pristine, getModels }
    // Pi's typed reads, `getModelsOfType()` and `getAllAvailable()` among them, list through this instead.
    if (pristine.getAllModels !== undefined) {
      wrapper.getAllModels = () => [...getModels(), ...passthroughModels(pristine)]
    }

    return wrapper
  }

  private applyNative(providerId: string, catalog: CatalogSnapshot): void {
    const fingerprint = catalog.sources
      .map(source => `${source.source}@${source.fetchedAt ?? 0}#${source.entryCount}`)
      .join('|')
    if (this.registeredCatalog.get(providerId) === fingerprint) {
      return
    }
    try {
      // A provider object becomes Pi's base for the id, so its `getModels()` is the last word on the list.
      this.pi.registerProvider(this.wrappers.get(providerId)!)
      this.registeredCatalog.set(providerId, fingerprint)
    } catch (error) {
      this.fail(providerId, 'native', error, [])
    }
  }

  private applyRegistration(providerId: string, tracked: Tracked): void {
    // Every model, always: a registered list replaces the whole one, so anything left out disappears from Pi.
    const completed = tracked.snapshot.map(snapshot => this.complete(tracked.provider, snapshot))
    const reports = completed.map(entry => entry.report)
    const models: ProviderModelConfig[] = [...completed.map(entry => entry.model), ...tracked.others]
    try {
      // Only `models` and a sibling's refresh hook: registerProvider merges keys and never expires them, so any
      // other key would permanently shadow the sibling's, and a relay's apiKey usually lives there.
      this.pi.registerProvider(
        providerId,
        tracked.refresh === undefined ? { models } : { models, refreshModels: tracked.refresh },
      )
      this.lastRegistered.set(providerId, models)
      this.reports.set(providerId, {
        provider: providerId,
        status: 'applied',
        strategy: tracked.strategy,
        reason: undefined,
        models: reports,
      })
    } catch (error) {
      this.fail(providerId, tracked.strategy, error, reports)
    }
  }

  /**
   * Completes inside Pi's own refresh: the sibling returns the clean upstream list, and `/model` renders the
   * completed one in the same pass that fetched it.
   */
  private decorate(providerId: string, original: RefreshModels): RefreshModels {
    const decorated = async (context: Parameters<RefreshModels>[0]): Promise<ProviderModelConfig[]> => {
      const fresh = await original(context)
      const tracked = this.tracked.get(providerId)
      if (tracked === undefined || fresh.length === 0) {
        return fresh
      }
      tracked.snapshot = fresh.flatMap(definition => toSnapshot(definition, tracked.api, tracked.baseUrl) ?? [])
      tracked.others = fresh.filter(definition => !isChat(definition))
      const completed = tracked.snapshot.map(snapshot => this.complete(tracked.provider, snapshot))

      // A definition that could not be typed stays as the sibling wrote it, in place, as does a non-chat entry
      // sharing a chat model's id.
      const byId = new Map(completed.map(({ model }) => [model.id, model]))
      const models = fresh.map(definition =>
        isChat(definition) ? (byId.get(definition.id) ?? definition) : definition,
      )
      this.lastRegistered.set(providerId, models)
      this.reports.set(providerId, {
        provider: providerId,
        status: 'applied',
        strategy: 'decorate',
        reason: undefined,
        models: completed.map(entry => entry.report),
      })

      return models
    }

    return Object.assign(decorated, { [DECORATED]: original })
  }

  /**
   * A session whose config drops a provider would otherwise leave our registration behind, where a later recompose
   * could delete the provider outright.
   */
  private releaseStale(registry: ModelRegistry, config: ResolvedConfig): void {
    for (const providerId of this.wrappers.keys()) {
      if (config.providers.has(providerId)) {
        continue
      }
      const native = registry.getRegisteredNativeProvider(providerId)
      if (native === undefined || !(WRAPPED in native)) {
        this.wrappers.delete(providerId)
      } else if (registry.getRegisteredProviderConfig(providerId) === undefined) {
        // unregisterProvider drops the whole entry, so it is only safe while ours is the only one.
        this.release(providerId)
      }
    }
    for (const [providerId, models] of this.lastRegistered) {
      // unregisterProvider would also drop a sibling's baseUrl and apiKey, so leaving ours is the lesser harm.
      if (!config.providers.has(providerId) && isSolelyOurs(registry.getRegisteredProviderConfig(providerId), models)) {
        this.release(providerId)
      }
    }
  }

  private release(providerId: string): void {
    try {
      this.pi.unregisterProvider(providerId)
      this.lastRegistered.delete(providerId)
      this.wrappers.delete(providerId)
      this.registeredCatalog.delete(providerId)
    } catch (error) {
      warn(`failed to release provider '${providerId}': ${describeError(error)}`)
    }
  }
}
