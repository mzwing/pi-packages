import type { CatalogEntry, CatalogIndex, NormalizedSource } from './types.js'
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

/** `sources` must come in priority order, so every bucket is ranked and the resolver never sorts by source. */
export function buildCatalogIndex(sources: NormalizedSource[]): CatalogIndex {
  const index: CatalogIndex = { scoped: new Map(), exact: new Map(), bare: new Map(), vendors: new Map() }

  for (const source of sources) {
    for (const [key, vendor] of source.vendors) {
      if (!index.vendors.has(key)) {
        index.vendors.set(key, vendor)
      }
    }
    for (const entry of source.entries) {
      const short = bareId(entry.sourceId)
      if (entry.sourceProvider !== undefined) {
        push(index.scoped, scopedKey(entry.sourceProvider, entry.sourceId), entry)
        if (short !== entry.sourceId) {
          push(index.scoped, scopedKey(entry.sourceProvider, short), entry)
        }
      }
      push(index.exact, entry.sourceId.toLowerCase(), entry)
      if (entry.canonicalId !== entry.sourceId) {
        push(index.exact, entry.canonicalId.toLowerCase(), entry)
      }
      push(index.bare, short.toLowerCase(), entry)
    }
  }

  return index
}
