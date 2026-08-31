import type { CatalogSnapshot } from '../src/catalog.js'
import type { ProviderReport } from '../src/provider-apply.js'
import type { Resolution } from '../src/types.js'
import { describe, expect, it } from 'vitest'
import { buildCatalogIndex } from '../src/catalog-index.js'
import { buildCompletions, formatDetail, formatSummary } from '../src/command.js'
import { mergeMetadata } from '../src/merge.js'
import { entry, makeProvider, makeSnapshot, suffixRule } from './helpers.js'

const NOW = 1_000_000

function report(resolution: Resolution, id = 'gpt-5.5'): ProviderReport {
  const merged = mergeMetadata({
    snapshot: makeSnapshot({ id }),
    provider: makeProvider(),
    resolution,
    gate: undefined,
  })
  return {
    provider: 'relay',
    status: 'applied',
    reason: undefined,
    models: [{ id, resolution, provenance: merged.provenance, issues: merged.issues, model: merged.model }],
  }
}

const RESOLVED: Resolution = {
  kind: 'resolved',
  entry: entry({ id: 'openai/gpt-5.5', contextWindow: 400_000, maxTokens: 128_000, reasoning: true }),
  donor: undefined,
  matchKind: 'stripped',
  prefixRule: undefined,
  suffixRule: suffixRule('free-dash', '-free', { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
}

const catalog: CatalogSnapshot = {
  index: buildCatalogIndex([], ['pi.dev', 'models.dev']),
  status: 'ready',
  sources: [
    { source: 'pi.dev', fetchedAt: NOW - 30 * 60_000, entryCount: 1274, lastError: undefined },
    { source: 'models.dev', fetchedAt: undefined, entryCount: 0, lastError: 'ETIMEDOUT' },
  ],
}

describe('summary', () => {
  it('counts each outcome and shows the catalog state', () => {
    const text = formatSummary([report(RESOLVED)], catalog, [], NOW)
    expect(text).toContain('relay: 1 completed, 0 ambiguous, 0 unresolved')
    expect(text).toContain('pi.dev: 1274 entries, 30m ago')
    expect(text).toContain('models.dev: 0 entries, never fetched — ETIMEDOUT')
  })

  it('says how current each list stays', () => {
    const live = { ...report(RESOLVED), strategy: 'native' as const }
    expect(formatSummary([live], catalog, [], NOW)).toContain('(1 models) · list re-read live')
  })

  it('explains an empty opt-in list', () => {
    expect(formatSummary([], catalog, [], NOW)).toContain('No providers opted in')
  })

  it('gives the reason for a skipped provider', () => {
    const skipped: ProviderReport = {
      provider: 'relay',
      status: 'skipped',
      reason: 'no models to complete',
      models: [],
    }
    expect(formatSummary([skipped], catalog, [], NOW)).toContain('relay: skipped — no models to complete')
  })

  it('surfaces config issues', () => {
    const text = formatSummary([], catalog, [{ sourcePath: '/agent/config.json', message: 'bad rule' }], NOW)
    expect(text).toContain('/agent/config.json: bad rule')
  })

  it('says so when nothing could be loaded', () => {
    expect(formatSummary([], { ...catalog, status: 'unavailable' }, [], NOW)).toContain(
      'unavailable — nothing was applied',
    )
  })
})

describe('detail', () => {
  it('shows the canonical id, match kind, rule and per-field source', () => {
    const text = formatDetail([report(RESOLVED)], 'relay/gpt-5.5', undefined)
    expect(text).toContain('requested:  relay/gpt-5.5')
    expect(text).toContain('canonical:  openai/gpt-5.5  (pi.dev)')
    expect(text).toContain('match:      stripped')
    expect(text).toContain('rule:       free-dash')
    expect(text).toContain('context:    400000   from pi.dev')
    expect(text).toContain("from rule 'free-dash'")
  })

  it('lists the candidates for an ambiguous model', () => {
    const ambiguous: Resolution = {
      kind: 'ambiguous',
      candidates: [entry({ provider: 'openai', id: 'gpt-5.5' }), entry({ provider: 'azure', id: 'gpt-5.5' })],
    }
    const text = formatDetail([report(ambiguous)], 'relay/gpt-5.5', undefined)
    expect(text).toContain('ambiguous — nothing was applied')
    expect(text).toContain('openai/gpt-5.5')
    expect(text).toContain('azure/gpt-5.5')
    expect(text).toContain('Add an alias')
  })

  it('states why a model is unresolved', () => {
    const text = formatDetail([report({ kind: 'unresolved', reason: 'alias-miss' })], 'relay/gpt-5.5', undefined)
    expect(text).toContain('unresolved (alias-miss)')
  })

  it('reports what Pi actually uses when modelOverrides disagree', () => {
    // models.json modelOverrides are layered above this extension.
    const effective = makeSnapshot({ id: 'gpt-5.5', contextWindow: 1_000 })
    const text = formatDetail([report(RESOLVED)], 'relay/gpt-5.5', effective)
    expect(text).toContain('Pi is using different values')
    expect(text).toContain('context: 1000')
  })

  it('stays quiet when the effective model agrees', () => {
    const reports = [report(RESOLVED)]
    const effective = reports[0]?.models[0]?.model as never
    expect(formatDetail(reports, 'relay/gpt-5.5', effective)).not.toContain('Pi is using different values')
  })

  it('points at the summary for an unknown reference', () => {
    expect(formatDetail([], 'relay/nope', undefined)).toContain('No completed model matches')
  })

  it('notes the other providers serving the same bare id', () => {
    const reports = [report(RESOLVED), { ...report(RESOLVED), provider: 'other' }]
    expect(formatDetail(reports, 'gpt-5.5', undefined)).toContain('also exists on: other')
  })
})

describe('completions', () => {
  it('offers the verb and every completed model', () => {
    const items = buildCompletions([report(RESOLVED)], '')
    expect(items?.map(item => item.value)).toEqual(['refresh', 'relay/gpt-5.5'])
  })

  it('filters by substring', () => {
    expect(buildCompletions([report(RESOLVED)], 'gpt')?.map(item => item.value)).toEqual(['relay/gpt-5.5'])
  })

  it('returns null rather than an empty list', () => {
    expect(buildCompletions([report(RESOLVED)], 'zzz')).toBeNull()
  })

  it('caps how much it returns', () => {
    const many: ProviderReport = {
      provider: 'relay',
      status: 'applied',
      reason: undefined,
      models: Array.from({ length: 200 }, (_unused, index) => report(RESOLVED, `m-${index}`).models[0]!),
    }
    expect(buildCompletions([many], '')?.length).toBeLessThanOrEqual(50)
  })
})
