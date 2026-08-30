import type { CatalogCacheFileSystem } from '../src/cache.js'
import type { CatalogFetcher, CatalogRequest, FetchOutcome } from '../src/fetcher.js'
import { describe, expect, it, vi } from 'vitest'
import { CACHE_VERSION, CatalogCache } from '../src/cache.js'
import { CatalogStore } from '../src/catalog.js'
import { makeConfig } from './helpers.js'

function memoryFs(
  seed: Record<string, string> = {},
): CatalogCacheFileSystem & { files: Map<string, string>; writes: number } {
  const files = new Map(Object.entries(seed))
  const state = {
    files,
    writes: 0,
    readFile: (path: string) => files.get(path),
    writeFile: (path: string, data: string) => {
      state.writes += 1
      files.set(path, data)
    },
    rename: (from: string, to: string) => {
      const data = files.get(from)
      files.delete(from)
      if (data !== undefined) {
        files.set(to, data)
      }
    },
    mkdir: () => {},
    unlink: (path: string) => {
      files.delete(path)
    },
  }
  return state
}

const PI_DEV_PAYLOAD = { openai: { 'gpt-5.5': { id: 'gpt-5.5', contextWindow: 400_000 } } }

function fetcherReturning(...outcomes: FetchOutcome[]): CatalogFetcher & { calls: number; requests: CatalogRequest[] } {
  const state = {
    calls: 0,
    requests: [] as CatalogRequest[],
    get: async (request: CatalogRequest): Promise<FetchOutcome> => {
      const outcome = outcomes[Math.min(state.calls, outcomes.length - 1)]
      state.calls += 1
      state.requests.push(request)
      return outcome ?? { status: 'error', message: 'no outcome' }
    },
  }
  return state
}

const OK: FetchOutcome = { status: 'ok', body: PI_DEV_PAYLOAD, etag: '"v1"', lastModified: undefined }

function store(fs: CatalogCacheFileSystem, fetcher: CatalogFetcher, now = 1_000_000): CatalogStore {
  return new CatalogStore({
    cache: new CatalogCache({ dir: '/cache', fileSystem: fs }),
    fetcher,
    now: () => now,
    random: () => 0.5,
  })
}

const config = makeConfig({ sources: ['pi.dev'] })

describe('cache envelope', () => {
  it('writes through a temp file and reads back', () => {
    const fs = memoryFs()
    const cache = new CatalogCache({ dir: '/cache', fileSystem: fs })
    cache.write({
      version: CACHE_VERSION,
      source: 'pi.dev',
      etag: '"v1"',
      lastModified: undefined,
      fetchedAt: 5,
      entryCount: 0,
      entries: [],
      vendors: [],
    })
    expect([...fs.files.keys()]).toEqual(['/cache/pi-dev.json'])
    expect(cache.read('pi.dev')?.etag).toBe('"v1"')
  })

  it('treats a corrupt or mismatched envelope as absent without deleting it', () => {
    const corrupt = memoryFs({ '/cache/pi-dev.json': 'not json' })
    expect(new CatalogCache({ dir: '/cache', fileSystem: corrupt }).read('pi.dev')).toBeUndefined()
    expect(corrupt.files.has('/cache/pi-dev.json')).toBe(true)

    const wrongVersion = memoryFs({
      '/cache/pi-dev.json': JSON.stringify({
        version: 99,
        source: 'pi.dev',
        fetchedAt: 1,
        entryCount: 0,
        entries: [],
        vendors: [],
      }),
    })
    expect(new CatalogCache({ dir: '/cache', fileSystem: wrongVersion }).read('pi.dev')).toBeUndefined()

    const truncated = memoryFs({
      '/cache/pi-dev.json': JSON.stringify({
        version: CACHE_VERSION,
        source: 'pi.dev',
        fetchedAt: 1,
        entryCount: 5,
        entries: [],
        vendors: [],
      }),
    })
    expect(new CatalogCache({ dir: '/cache', fileSystem: truncated }).read('pi.dev')).toBeUndefined()
  })
})

describe('refresh', () => {
  it('fetches, normalises and persists', async () => {
    const fs = memoryFs()
    const fetcher = fetcherReturning(OK)
    const snapshot = await store(fs, fetcher).refresh(config, new AbortController().signal)

    expect(fetcher.calls).toBe(1)
    expect(snapshot.status).toBe('ready')
    expect(snapshot.sources[0]).toMatchObject({ source: 'pi.dev', entryCount: 1, lastError: undefined })
    expect(fs.files.has('/cache/pi-dev.json')).toBe(true)
  })

  it('skips the network entirely while the cache is fresh', async () => {
    const fs = memoryFs()
    const fetcher = fetcherReturning(OK)
    await store(fs, fetcher).refresh(config, new AbortController().signal)

    const second = fetcherReturning(OK)
    await store(fs, second).refresh(config, new AbortController().signal)
    expect(second.calls).toBe(0)
  })

  it('reuses the cached entries on 304 and bumps only the timestamp', async () => {
    const fs = memoryFs()
    await store(fs, fetcherReturning(OK)).refresh(config, new AbortController().signal)
    const writesAfterFirst = fs.writes

    const fetcher = fetcherReturning({ status: 'not-modified' })
    const later = store(fs, fetcher, 1_000_000 + 10 * 24 * 60 * 60 * 1000)
    const snapshot = await later.refresh(config, new AbortController().signal)

    expect(fetcher.calls).toBe(1)
    expect(snapshot.sources[0]?.entryCount).toBe(1)
    expect(fs.writes).toBe(writesAfterFirst + 1)
  })

  it('serves stale entries and records the error when the fetch fails', async () => {
    const fs = memoryFs()
    await store(fs, fetcherReturning(OK)).refresh(config, new AbortController().signal)
    const before = fs.files.get('/cache/pi-dev.json')

    const later = store(
      fs,
      fetcherReturning({ status: 'error', message: 'ETIMEDOUT' }),
      1_000_000 + 10 * 24 * 60 * 60 * 1000,
    )
    const snapshot = await later.refresh(config, new AbortController().signal)

    expect(snapshot.status).toBe('ready')
    expect(snapshot.sources[0]).toMatchObject({ entryCount: 1, lastError: 'ETIMEDOUT' })
    expect(fs.files.get('/cache/pi-dev.json')).toBe(before)
  })

  it('keeps the cached copy when the payload yields nothing usable', async () => {
    const fs = memoryFs()
    await store(fs, fetcherReturning(OK)).refresh(config, new AbortController().signal)

    const empty: FetchOutcome = { status: 'ok', body: {}, etag: undefined, lastModified: undefined }
    const later = store(fs, fetcherReturning(empty), 1_000_000 + 10 * 24 * 60 * 60 * 1000)
    const snapshot = await later.refresh(config, new AbortController().signal)

    expect(snapshot.sources[0]).toMatchObject({ entryCount: 1, lastError: 'catalog contained no usable models' })
  })

  it('reports unavailable with no cache and no network', async () => {
    const offline = makeConfig({ sources: ['pi.dev'], network: { enabled: false, timeoutMs: 1, maxBytes: 1 } })
    const fetcher = fetcherReturning(OK)
    const snapshot = await store(memoryFs(), fetcher).refresh(offline, new AbortController().signal)

    expect(fetcher.calls).toBe(0)
    expect(snapshot.status).toBe('unavailable')
  })

  it('honours an abort before the fetch', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetcher = fetcherReturning(OK)
    await store(memoryFs(), fetcher).refresh(config, controller.signal)
    expect(fetcher.calls).toBe(0)
  })

  it('re-fetches when forced, even inside the TTL', async () => {
    const fs = memoryFs()
    await store(fs, fetcherReturning(OK)).refresh(config, new AbortController().signal)
    const fetcher = fetcherReturning(OK)
    await store(fs, fetcher).refresh(config, new AbortController().signal, true)
    expect(fetcher.calls).toBe(1)
  })

  it('applies the configured network limits to the request', async () => {
    const limited = makeConfig({ sources: ['pi.dev'], network: { enabled: true, timeoutMs: 2_500, maxBytes: 4_096 } })
    const fetcher = fetcherReturning(OK)
    await store(memoryFs(), fetcher).refresh(limited, new AbortController().signal)
    expect(fetcher.requests[0]).toMatchObject({ timeoutMs: 2_500, maxBytes: 4_096 })
  })
})

describe('jitter', () => {
  it('scales the ttl within ten percent either way', async () => {
    const random = vi.fn<() => number>().mockReturnValue(0)
    const fs = memoryFs()
    await store(fs, fetcherReturning(OK)).refresh(config, new AbortController().signal)

    // ttl is 60s; at random()=0 the effective window is 54s, so 55s is stale.
    const fetcher = fetcherReturning(OK)
    const later = new CatalogStore({
      cache: new CatalogCache({ dir: '/cache', fileSystem: fs }),
      fetcher,
      now: () => 1_000_000 + 55_000,
      random,
    })
    await later.refresh(config, new AbortController().signal)
    expect(fetcher.calls).toBe(1)
  })
})

describe('load', () => {
  it('reads the cache without touching the network', () => {
    const fs = memoryFs()
    const fetcher = fetcherReturning(OK)
    const snapshot = store(fs, fetcher).load(config)
    expect(fetcher.calls).toBe(0)
    expect(snapshot.status).toBe('unavailable')
  })
})
