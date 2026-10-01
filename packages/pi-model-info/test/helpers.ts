import type {
  AffixRule,
  CatalogIndex,
  CatalogEntry,
  MetadataOverride,
  NormalizedSource,
  ResolvedConfig,
  ResolvedProvider,
  SnapshotModel,
  SourceId,
} from '../src/types.js'
import type { Api } from '@earendil-works/pi-ai'
import type { Mock } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import { buildCatalogIndex } from '../src/catalog-index.js'
import { bareId, vendorOf } from '../src/catalog-sources.js'

/** A throwaway project and agent dir, with `PI_CODING_AGENT_DIR` pointed at the latter. */
export function useWorkspace(): { cwd: string; agentDir: string } {
  const workspace = { cwd: '', agentDir: '' }
  let root = ''
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pi-model-info-'))
    workspace.cwd = join(root, 'project')
    workspace.agentDir = join(root, 'agent')
    vi.stubEnv('PI_CODING_AGENT_DIR', workspace.agentDir)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  return workspace
}

export function writeFile(path: string, contents: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents))
}

/** Answers catalog requests from `respond`, keyed by the requested URL. */
export function stubFetch(
  respond: (url: string, headers: Headers, signal: AbortSignal) => Response | Promise<Response>,
): Mock<(url: string | URL, init?: RequestInit) => Promise<Response>> {
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) =>
    respond(String(url), new Headers(init?.headers), init?.signal ?? new AbortController().signal),
  )
  vi.stubGlobal('fetch', fetch)

  return fetch
}

export function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers })
}

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

export function makeIndex(specs: EntrySpec[], order: SourceId[] = ['pi.dev', 'models.dev']): CatalogIndex {
  const sources = order.map((source): NormalizedSource => ({ source, entries: [], vendors: new Map() }))
  for (const spec of specs) {
    const built = entry(spec)
    const bucket = sources.find(source => source.source === built.source)
    bucket?.entries.push(built)
    // Only models.dev contributes the vendor oracle, exactly as in production.
    if (built.source === 'models.dev' && built.sourceProvider !== undefined) {
      bucket?.vendors.set(built.sourceId.toLowerCase(), built.sourceProvider)
    }
  }

  return buildCatalogIndex(sources)
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
    models: new Map(),
    ...overrides,
  }
}

export function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    providers: new Map(),
    prefixRules: [],
    suffixRules: [],
    sources: ['pi.dev', 'models.dev'],
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
