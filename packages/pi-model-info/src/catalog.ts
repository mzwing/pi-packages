import type { CachedEnvelope } from './cache.js'
import type { CatalogFetcher } from './fetcher.js'
import type { CatalogIndex, NormalizedSource, ResolvedConfig, SourceId } from './types.js'
import { CACHE_VERSION, CatalogCache, toNormalizedSource } from './cache.js'
import { buildCatalogIndex } from './catalog-index.js'
import { MODELS_DEV_URL, normalizeModelsDev, normalizePiDev, PI_DEV_URL } from './catalog-sources.js'
import { catalogFetcher } from './fetcher.js'

interface SourceDescriptor {
  url: string
  normalize: (payload: unknown) => NormalizedSource
}

const SOURCES: Record<SourceId, SourceDescriptor> = {
  'pi.dev': { url: PI_DEV_URL, normalize: normalizePiDev },
  'models.dev': { url: MODELS_DEV_URL, normalize: normalizeModelsDev },
}

interface SourceStatus {
  source: SourceId
  fetchedAt: number | undefined
  entryCount: number
  lastError: string | undefined
}

export interface CatalogSnapshot {
  index: CatalogIndex
  /** `unavailable` means nothing was loaded, so nothing may be registered. */
  status: 'ready' | 'unavailable'
  sources: SourceStatus[]
}

export interface CatalogStoreDeps {
  cache?: CatalogCache | undefined
  fetcher?: CatalogFetcher | undefined
  now?: (() => number) | undefined
  random?: (() => number) | undefined
}

export class CatalogStore {
  private readonly cache: CatalogCache
  private readonly fetcher: CatalogFetcher
  private readonly now: () => number
  private readonly random: () => number
  private readonly errors = new Map<SourceId, string>()

  constructor(deps: CatalogStoreDeps = {}) {
    this.cache = deps.cache ?? new CatalogCache()
    this.fetcher = deps.fetcher ?? catalogFetcher
    this.now = deps.now ?? (() => Date.now())
    this.random = deps.random ?? Math.random
  }

  /** Cache only. Safe to call before any network work has happened. */
  load(config: ResolvedConfig): CatalogSnapshot {
    const loaded = new Map<SourceId, CachedEnvelope>()
    for (const source of config.sources) {
      const cached = this.cache.read(source)
      if (cached !== undefined) {
        loaded.set(source, cached)
      }
    }

    return this.snapshot(config, loaded)
  }

  async refresh(config: ResolvedConfig, signal: AbortSignal, force = false): Promise<CatalogSnapshot> {
    const loaded = new Map<SourceId, CachedEnvelope>()

    for (const source of config.sources) {
      const envelope = await this.refreshOne(config, source, signal, force)
      if (envelope !== undefined) {
        loaded.set(source, envelope)
      }
      if (signal.aborted) {
        break
      }
    }

    return this.snapshot(config, loaded)
  }

  private async refreshOne(
    config: ResolvedConfig,
    source: SourceId,
    signal: AbortSignal,
    force: boolean,
  ): Promise<CachedEnvelope | undefined> {
    const descriptor = SOURCES[source]
    const cached = this.cache.read(source)

    // Jitter keeps several Pi processes on one machine from expiring together.
    const ttl = config.cache.ttlMs * (0.9 + this.random() * 0.2)
    if (!force && cached !== undefined && this.now() - cached.fetchedAt < ttl) {
      this.errors.delete(source)

      return cached
    }
    if (!config.network.enabled || signal.aborted) {
      return cached
    }

    const outcome = await this.fetcher.get(
      {
        url: descriptor.url,
        etag: cached?.etag,
        lastModified: cached?.lastModified,
        timeoutMs: config.network.timeoutMs,
        maxBytes: config.network.maxBytes,
      },
      signal,
    )

    if (outcome.status === 'not-modified') {
      if (cached === undefined) {
        this.errors.set(source, '304 with no cached copy')

        return undefined
      }
      const renewed: CachedEnvelope = { ...cached, fetchedAt: this.now() }
      this.persist(source, renewed)
      this.errors.delete(source)

      return renewed
    }

    if (outcome.status === 'error') {
      // Stale-on-failure: an old catalog beats no catalog, and the file is untouched.
      this.errors.set(source, outcome.message)

      return cached
    }

    const normalized = descriptor.normalize(outcome.body)
    if (normalized.entries.length === 0) {
      this.errors.set(source, 'catalog contained no usable models')

      return cached
    }

    const envelope: CachedEnvelope = {
      version: CACHE_VERSION,
      source,
      etag: outcome.etag,
      lastModified: outcome.lastModified,
      fetchedAt: this.now(),
      entryCount: normalized.entries.length,
      entries: normalized.entries,
      vendors: [...normalized.vendors],
    }
    this.persist(source, envelope)
    this.errors.delete(source)

    return envelope
  }

  private persist(source: SourceId, envelope: CachedEnvelope): void {
    try {
      this.cache.write(envelope)
    } catch (error) {
      // A cache we cannot write is a slower extension, not a broken one.
      this.errors.set(source, `cache write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private snapshot(config: ResolvedConfig, loaded: Map<SourceId, CachedEnvelope>): CatalogSnapshot {
    const sources = config.sources.map((source): SourceStatus => {
      const envelope = loaded.get(source)

      return {
        source,
        fetchedAt: envelope?.fetchedAt,
        entryCount: envelope?.entries.length ?? 0,
        lastError: this.errors.get(source),
      }
    })

    const normalized = config.sources
      .map(source => loaded.get(source))
      .filter((envelope): envelope is CachedEnvelope => envelope !== undefined)
      .map(toNormalizedSource)

    return {
      index: buildCatalogIndex(normalized, config.sources),
      status: normalized.some(source => source.entries.length > 0) ? 'ready' : 'unavailable',
      sources,
    }
  }
}
