import type {
  AffixRule,
  CatalogEntry,
  CatalogIndex,
  MetadataOverride,
  ModelGate,
  NormalizedSource,
  ResolvedConfig,
  ResolvedProvider,
  SnapshotModel,
  SourceId,
} from '../src/types.js'
import type { Api } from '@earendil-works/pi-ai'
import { buildCatalogIndex } from '../src/catalog-index.js'
import { bareId, vendorOf } from '../src/catalog-sources.js'
import { DEFAULT_SOURCES } from '../src/config.js'

export interface EntrySpec extends MetadataOverride {
  source?: SourceId
  /** Defaults to the vendor in `id`, matching how both catalogs are namespaced. */
  provider?: string
  id: string
  api?: Api
}

export function entry(spec: EntrySpec): CatalogEntry {
  const { source = 'pi.dev', provider, id, api, ...metadata } = spec
  const sourceProvider = provider ?? vendorOf(id)
  const short = bareId(id)
  return {
    source,
    sourceProvider,
    sourceId: short,
    canonicalId: sourceProvider === undefined ? short : `${sourceProvider}/${short}`,
    ...(api === undefined ? {} : { api }),
    metadata,
  }
}

export function makeIndex(specs: EntrySpec[], order: SourceId[] = DEFAULT_SOURCES): CatalogIndex {
  const bySource = new Map<SourceId, NormalizedSource>()
  for (const source of order) {
    bySource.set(source, { source, entries: [], vendors: new Map() })
  }
  for (const spec of specs) {
    const built = entry(spec)
    const bucket = bySource.get(built.source)
    if (bucket === undefined) {
      continue
    }
    bucket.entries.push(built)
    // Only models.dev contributes the vendor oracle, exactly as in production.
    if (built.source === 'models.dev' && built.sourceProvider !== undefined) {
      bucket.vendors.set(built.sourceId.toLowerCase(), built.sourceProvider)
    }
  }
  return buildCatalogIndex([...bySource.values()], order)
}

export function makeProvider(overrides: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return {
    id: 'relay',
    catalogProvider: undefined,
    costMultiplier: 1,
    costPolicy: 'catalog',
    contextWindowPolicy: 'catalog',
    capabilityPolicy: 'catalog',
    useCatalogName: false,
    mapThinkingLevels: false,
    allowDynamic: false,
    models: new Map<string, ModelGate>(),
    ...overrides,
  }
}

export function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    providers: new Map(),
    prefixRules: [],
    suffixRules: [],
    sources: DEFAULT_SOURCES,
    network: { enabled: true, timeoutMs: 1000, maxBytes: 1_000_000 },
    cache: { ttlMs: 60_000, dir: undefined },
    applyOnIdleOnly: false,
    ...overrides,
  }
}

/** Pi's placeholders for a model it knows nothing about. */
export function makeSnapshot(overrides: Partial<SnapshotModel> = {}): SnapshotModel {
  return {
    id: 'gpt-5.5',
    name: 'gpt-5.5',
    api: 'openai-completions',
    baseUrl: 'http://localhost:8317/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    ...overrides,
  }
}

export function suffixRule(id: string, value: string, override?: MetadataOverride): AffixRule {
  return { id, kind: 'suffix', value, ...(override === undefined ? {} : { override }) }
}

export function prefixRule(id: string, value: string, override?: MetadataOverride): AffixRule {
  return { id, kind: 'prefix', value, ...(override === undefined ? {} : { override }) }
}
