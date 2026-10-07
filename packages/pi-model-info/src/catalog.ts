import type { CatalogEntry, CatalogIndex, NormalizedSource, ResolvedConfig, SourceId } from './types.js'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { buildCatalogIndex } from './catalog-index.js'
import { normalizeModelsDev, normalizePiDev } from './catalog-sources.js'
import { EXTENSION_ID } from './config.js'
import { describeError } from './util.js'

const CACHE_VERSION = 1

const SOURCES: Record<SourceId, { url: string; file: string; normalize: (payload: unknown) => NormalizedSource }> = {
  'pi.dev': { url: 'https://pi.dev/api/models', file: 'pi-dev.json', normalize: normalizePiDev },
  'models.dev': { url: 'https://models.dev/models.json', file: 'models-dev.json', normalize: normalizeModelsDev },
}

interface CachedEnvelope {
  version: number
  source: SourceId
  etag: string | undefined
  lastModified: string | undefined
  fetchedAt: number
  entryCount: number
  entries: CatalogEntry[]
  /** `Map` does not survive JSON, so the vendor oracle is persisted as pairs. */
  vendors: [string, string][]
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

function cachePath(config: ResolvedConfig, source: SourceId): string {
  return join(config.cache.dir ?? join(getAgentDir(), 'extensions', EXTENSION_ID, 'cache'), SOURCES[source].file)
}

/** A corrupt or foreign envelope reads as absent and stays on disk until the next successful fetch replaces it. */
function readCache(config: ResolvedConfig, source: SourceId): CachedEnvelope | undefined {
  let envelope: Partial<CachedEnvelope> | null
  try {
    envelope = JSON.parse(readFileSync(cachePath(config, source), 'utf8')) as Partial<CachedEnvelope> | null
  } catch {
    return undefined
  }
  const usable =
    envelope?.version === CACHE_VERSION &&
    envelope.source === source &&
    Array.isArray(envelope.entries) &&
    Array.isArray(envelope.vendors) &&
    typeof envelope.fetchedAt === 'number' &&
    envelope.entries.length === envelope.entryCount

  return usable ? (envelope as CachedEnvelope) : undefined
}

function writeCache(config: ResolvedConfig, envelope: CachedEnvelope): void {
  const path = cachePath(config, envelope.source)
  const temporary = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, 'utf8')
    renameSync(temporary, path)
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // The write error is the actionable one.
    }
    throw error
  }
}

/** Reads through the stream, so an oversized payload is abandoned rather than buffered whole. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) {
    return ''
  }
  // Node's `undici` types reach us as `any`, so the chunk shape is pinned here.
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      size += chunk.value.byteLength
      if (size > maxBytes) {
        throw new Error(`response exceeded ${maxBytes} bytes`)
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }

  return text + decoder.decode()
}

/** `undefined` for a 304, meaning the cached copy is still current. */
async function fetchCatalog(
  config: ResolvedConfig,
  source: SourceId,
  cached: CachedEnvelope | undefined,
  signal: AbortSignal,
): Promise<{ body: unknown; etag: string | undefined; lastModified: string | undefined } | undefined> {
  const headers = new Headers({ accept: 'application/json' })
  if (cached?.etag !== undefined) {
    headers.set('if-none-match', cached.etag)
  }
  if (cached?.lastModified !== undefined) {
    headers.set('if-modified-since', cached.lastModified)
  }
  const response = await fetch(SOURCES[source].url, {
    headers,
    signal: AbortSignal.any([signal, AbortSignal.timeout(config.network.timeoutMs)]),
  })
  if (!response.ok) {
    await response.body?.cancel()
    if (response.status === 304) {
      return undefined
    }
    throw new Error(`HTTP ${response.status}`)
  }

  return {
    body: JSON.parse(await readCapped(response, config.network.maxBytes)),
    etag: response.headers.get('etag') ?? undefined,
    lastModified: response.headers.get('last-modified') ?? undefined,
  }
}

export class CatalogStore {
  private readonly errors = new Map<SourceId, string>()

  /** Cache only, so it is safe before any network work has happened. */
  load(config: ResolvedConfig): CatalogSnapshot {
    return this.snapshot(
      config,
      config.sources.map(source => readCache(config, source)),
    )
  }

  async refresh(config: ResolvedConfig, signal: AbortSignal, force = false): Promise<CatalogSnapshot> {
    const envelopes: (CachedEnvelope | undefined)[] = []
    for (const source of config.sources) {
      envelopes.push(signal.aborted ? undefined : await this.refreshOne(config, source, signal, force))
    }

    return this.snapshot(config, envelopes)
  }

  private async refreshOne(
    config: ResolvedConfig,
    source: SourceId,
    signal: AbortSignal,
    force: boolean,
  ): Promise<CachedEnvelope | undefined> {
    const cached = readCache(config, source)
    // Jitter keeps several Pi processes on one machine from expiring together.
    const ttl = config.cache.ttlMs * (0.9 + Math.random() * 0.2)
    if (!force && cached !== undefined && Date.now() - cached.fetchedAt < ttl) {
      this.errors.delete(source)

      return cached
    }
    if (!config.network.enabled || signal.aborted) {
      return cached
    }

    let envelope: CachedEnvelope
    try {
      const fetched = await fetchCatalog(config, source, cached, signal)
      if (fetched === undefined) {
        if (cached === undefined) {
          throw new Error('304 with no cached copy')
        }
        envelope = { ...cached, fetchedAt: Date.now() }
      } else {
        const { entries, vendors } = SOURCES[source].normalize(fetched.body)
        if (entries.length === 0) {
          throw new Error('catalog contained no usable models')
        }
        envelope = {
          version: CACHE_VERSION,
          source,
          etag: fetched.etag,
          lastModified: fetched.lastModified,
          fetchedAt: Date.now(),
          entryCount: entries.length,
          entries,
          vendors: [...vendors],
        }
      }
    } catch (error) {
      // An old catalog beats no catalog, and the file on disk stays untouched.
      this.errors.set(source, describeError(error))

      return cached
    }

    this.errors.delete(source)
    try {
      writeCache(config, envelope)
    } catch (error) {
      // A cache that cannot be written is a slower extension, not a broken one.
      this.errors.set(source, `cache write failed: ${describeError(error)}`)
    }

    return envelope
  }

  /** `envelopes` line up with `config.sources`, which is priority order. */
  private snapshot(config: ResolvedConfig, envelopes: (CachedEnvelope | undefined)[]): CatalogSnapshot {
    const loaded = envelopes.filter(envelope => envelope !== undefined)

    return {
      index: buildCatalogIndex(
        loaded.map(envelope => ({
          source: envelope.source,
          entries: envelope.entries,
          vendors: new Map(envelope.vendors),
        })),
      ),
      status: loaded.some(envelope => envelope.entries.length > 0) ? 'ready' : 'unavailable',
      sources: config.sources.map((source, position) => ({
        source,
        fetchedAt: envelopes[position]?.fetchedAt,
        entryCount: envelopes[position]?.entries.length ?? 0,
        lastError: this.errors.get(source),
      })),
    }
  }
}
