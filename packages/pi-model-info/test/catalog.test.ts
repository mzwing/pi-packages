import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CatalogStore } from '../src/catalog.js'
import { json, makeConfig, stubFetch, useWorkspace, writeFile } from './helpers.js'

const PI_DEV_PAYLOAD = { openai: { 'gpt-5.5': { id: 'gpt-5.5', contextWindow: 400_000 } } }
const LATER = 1_000_000 + 10 * 24 * 60 * 60 * 1000

describe('catalog store', () => {
  const workspace = useWorkspace()
  const config = makeConfig({ sources: ['pi.dev'] })
  const cacheFile = (): string => join(workspace.agentDir, 'extensions', 'pi-model-info', 'cache', 'pi-dev.json')

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 })
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function refresh(options = config) {
    return new CatalogStore().refresh(options, new AbortController().signal)
  }

  it('persists a fetched catalog and serves it from disk without the network', async () => {
    stubFetch(() => json(PI_DEV_PAYLOAD, { etag: '"v1"' }))
    await refresh()
    const fetch = stubFetch(() => json(PI_DEV_PAYLOAD))

    expect(new CatalogStore().load(config)).toMatchObject({ status: 'ready', sources: [{ entryCount: 1 }] })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('skips the network inside a ttl jittered by up to ten percent', async () => {
    stubFetch(() => json(PI_DEV_PAYLOAD))
    await refresh()
    const fetch = stubFetch(() => json(PI_DEV_PAYLOAD))

    vi.setSystemTime(1_000_000 + 55_000)
    await refresh()
    expect(fetch).not.toHaveBeenCalled()

    // The ttl is 60s, so at random() = 0 the window is 54s and 55s later is already stale.
    vi.mocked(Math.random).mockReturnValue(0)
    await refresh()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('revalidates with the stored etag and only bumps the timestamp on 304', async () => {
    stubFetch(() => json(PI_DEV_PAYLOAD, { etag: '"v1"' }))
    await refresh()
    vi.setSystemTime(LATER)
    const fetch = stubFetch((_url, headers) =>
      headers.get('if-none-match') === '"v1"' ? new Response(null, { status: 304 }) : json({}),
    )

    expect((await refresh()).sources[0]).toMatchObject({ entryCount: 1, fetchedAt: LATER, lastError: undefined })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('serves the stale copy and records the error when a fetch fails', async () => {
    stubFetch(() => json(PI_DEV_PAYLOAD))
    await refresh()
    const before = readFileSync(cacheFile(), 'utf8')
    vi.setSystemTime(LATER)
    stubFetch(() => {
      throw new Error('ETIMEDOUT')
    })

    expect(await refresh()).toMatchObject({ status: 'ready', sources: [{ entryCount: 1, lastError: 'ETIMEDOUT' }] })
    expect(readFileSync(cacheFile(), 'utf8')).toBe(before)
  })

  it('never replaces the cached copy with an oversized body or a catalog with nothing usable', async () => {
    stubFetch(() => json(PI_DEV_PAYLOAD))
    await refresh()
    vi.setSystemTime(LATER)

    const capped = makeConfig({ sources: ['pi.dev'], network: { enabled: true, timeoutMs: 1000, maxBytes: 8 } })
    expect((await refresh(capped)).sources[0]).toMatchObject({ entryCount: 1, lastError: 'response exceeded 8 bytes' })

    stubFetch(() => json({}))
    expect((await refresh()).sources[0]).toMatchObject({
      entryCount: 1,
      lastError: 'catalog contained no usable models',
    })
  })

  it('treats a corrupt or foreign envelope as absent without deleting it', () => {
    writeFile(cacheFile(), 'not json')
    expect(new CatalogStore().load(config).status).toBe('unavailable')
    expect(existsSync(cacheFile())).toBe(true)

    writeFile(cacheFile(), { version: 99, source: 'pi.dev', fetchedAt: 1, entryCount: 0, entries: [], vendors: [] })
    expect(new CatalogStore().load(config).status).toBe('unavailable')
  })

  it('honours a configured cache directory', async () => {
    const dir = join(workspace.cwd, 'catalogs')
    stubFetch(() => json(PI_DEV_PAYLOAD))
    await refresh(makeConfig({ sources: ['pi.dev'], cache: { ttlMs: 60_000, dir } }))

    expect(existsSync(join(dir, 'pi-dev.json'))).toBe(true)
  })
})
