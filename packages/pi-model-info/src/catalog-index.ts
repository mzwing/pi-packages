import type { CatalogEntry, CatalogIndex, NormalizedSource, SourceId } from './types.js'
import { bareId } from './catalog-sources.js'

/** NUL cannot appear in a provider or model id, so the composite key is unambiguous. */
const SCOPE_SEPARATOR = String.fromCharCode(0)

export function scopedKey(provider: string, id: string): string {
  return `${provider.toLowerCase()}${SCOPE_SEPARATOR}${id.toLowerCase()}`
}

function push(map: Map<string, CatalogEntry[]>, key: string, entry: CatalogEntry): void {
  const bucket = map.get(key)
  if (bucket === undefined) {
    map.set(key, [entry])
  } else {
    bucket.push(entry)
  }
}

/** Inserts in source-priority order, so every bucket is ranked and the resolver never sorts by source. */
export function buildCatalogIndex(sources: NormalizedSource[], order: SourceId[]): CatalogIndex {
  const rank = new Map<SourceId, number>(order.map((source, position) => [source, position]))
  const ordered = sources
    .filter(source => rank.has(source.source))
    .sort((a, b) => (rank.get(a.source) ?? 0) - (rank.get(b.source) ?? 0))

  const scoped = new Map<string, CatalogEntry[]>()
  const exact = new Map<string, CatalogEntry[]>()
  const bare = new Map<string, CatalogEntry[]>()
  const vendors = new Map<string, string>()

  for (const source of ordered) {
    for (const [key, vendor] of source.vendors) {
      if (!vendors.has(key)) {
        vendors.set(key, vendor)
      }
    }
    for (const entry of source.entries) {
      const short = bareId(entry.sourceId)
      if (entry.sourceProvider !== undefined) {
        push(scoped, scopedKey(entry.sourceProvider, entry.sourceId), entry)
        if (short !== entry.sourceId) {
          push(scoped, scopedKey(entry.sourceProvider, short), entry)
        }
      }
      push(exact, entry.sourceId.toLowerCase(), entry)
      if (entry.canonicalId !== entry.sourceId) {
        push(exact, entry.canonicalId.toLowerCase(), entry)
      }
      push(bare, short.toLowerCase(), entry)
    }
  }

  return { scoped, exact, bare, vendors }
}
