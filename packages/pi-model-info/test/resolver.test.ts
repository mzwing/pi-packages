import type { AffixRule, CatalogIndex, ModelGate, Resolution, ResolvedProvider } from '../src/types.js'
import { describe, expect, it } from 'vitest'
import { resolveModel } from '../src/resolver.js'
import { makeIndex, makeProvider, prefixRule, suffixRule } from './helpers.js'

const FREE = { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
const freeDash = suffixRule('free-dash', '-free', FREE)
const freeColon = suffixRule('free-colon', ':free', FREE)

function resolve(
  index: CatalogIndex,
  modelId: string,
  options: { provider?: ResolvedProvider; prefixes?: AffixRule[]; suffixes?: AffixRule[] } = {},
): Resolution {
  return resolveModel({
    index,
    provider: options.provider ?? makeProvider(),
    prefixRules: options.prefixes ?? [],
    suffixRules: options.suffixes ?? [],
    modelId,
  })
}

function gated(modelId: string, gate: ModelGate, overrides: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return makeProvider({ models: new Map([[modelId, gate]]), ...overrides })
}

describe('alias', () => {
  const index = makeIndex([
    { id: 'openai/gpt-5.6-sol', contextWindow: 1_000_000 },
    { id: 'openai/gpt-special', contextWindow: 1 },
  ])

  it('wins over an exact match', () => {
    const provider = gated('gpt-special', { alias: 'openai/gpt-5.6-sol' })
    const result = resolve(index, 'gpt-special', { provider })
    expect(result).toMatchObject({ kind: 'resolved', matchKind: 'alias' })
    expect(result.kind === 'resolved' && result.entry.canonicalId).toBe('openai/gpt-5.6-sol')
  })

  it('accepts a bare target', () => {
    const provider = gated('whatever', { alias: 'gpt-5.6-sol' })
    const result = resolve(index, 'whatever', { provider })
    expect(result.kind === 'resolved' && result.entry.canonicalId).toBe('openai/gpt-5.6-sol')
  })

  it('reports a miss instead of falling through to the exact match', () => {
    // Falling through would hide the typo forever behind a plausible result.
    const provider = gated('gpt-special', { alias: 'openai/does-not-exist' })
    expect(resolve(index, 'gpt-special', { provider })).toEqual({ kind: 'unresolved', reason: 'alias-miss' })
  })
})

describe('original id before stripping', () => {
  const index = makeIndex([
    { id: 'deepseek/r1', contextWindow: 100, cost: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } },
    { id: 'deepseek/r1:free', contextWindow: 100, ...FREE },
  ])

  it('prefers the free variant that genuinely exists upstream', () => {
    const result = resolve(index, 'r1:free', { suffixes: [freeColon] })
    expect(result).toMatchObject({ kind: 'resolved', matchKind: 'exact', suffixRule: undefined })
    expect(result.kind === 'resolved' && result.entry.canonicalId).toBe('deepseek/r1:free')
  })

  it('falls back to stripping only when the original is absent', () => {
    const result = resolve(index, 'r1-free', { suffixes: [freeDash] })
    expect(result).toMatchObject({ kind: 'resolved', matchKind: 'stripped' })
    expect(result.kind === 'resolved' && result.suffixRule?.id).toBe('free-dash')
    expect(result.kind === 'resolved' && result.entry.canonicalId).toBe('deepseek/r1')
  })
})

describe('affix stripping', () => {
  it('removes at most one suffix', () => {
    const index = makeIndex([{ id: 'x/m-free' }])
    const result = resolve(index, 'm-free-free', { suffixes: [freeDash] })
    expect(result.kind === 'resolved' && result.entry.canonicalId).toBe('x/m-free')
  })

  it('never applies two suffix rules at once', () => {
    const index = makeIndex([{ id: 'x/m' }])
    expect(resolve(index, 'm:free-free', { suffixes: [freeDash, freeColon] }).kind).toBe('unresolved')
  })

  it('removes one prefix and one suffix together', () => {
    const index = makeIndex([{ id: 'x/m' }])
    const result = resolve(index, 'beta-m-free', {
      prefixes: [prefixRule('beta', 'beta-')],
      suffixes: [freeDash],
    })
    expect(result).toMatchObject({ kind: 'resolved', matchKind: 'stripped' })
    expect(result.kind === 'resolved' && result.prefixRule?.id).toBe('beta')
    expect(result.kind === 'resolved' && result.suffixRule?.id).toBe('free-dash')
  })

  it('rejects a strip that would leave nothing', () => {
    const index = makeIndex([{ id: 'x/m' }])
    expect(resolve(index, '-free', { suffixes: [freeDash] }).kind).toBe('unresolved')
  })

  it('prefers the longest matching rule', () => {
    // A broad `-free` must not shadow a specific `-preview-free`.
    const index = makeIndex([{ id: 'x/m' }, { id: 'x/m-preview' }])
    const rules = [freeDash, suffixRule('preview-free', '-preview-free')].sort(
      (a, b) => b.value.length - a.value.length,
    )
    const result = resolve(index, 'm-preview-free', { suffixes: rules })
    expect(result.kind === 'resolved' && result.suffixRule?.id).toBe('preview-free')
    expect(result.kind === 'resolved' && result.entry.canonicalId).toBe('x/m')
  })

  it('tries a single strip before a double strip', () => {
    // `m-preview` exists, so `-preview` must survive when only `-free` was needed.
    const index = makeIndex([{ id: 'x/m' }, { id: 'x/m-preview' }])
    const result = resolve(index, 'm-preview-free', {
      prefixes: [],
      suffixes: [freeDash],
    })
    expect(result.kind === 'resolved' && result.entry.canonicalId).toBe('x/m-preview')
  })
})

describe('per-model rule gating', () => {
  const index = makeIndex([{ id: 'x/m' }])

  it('uses every rule when unset', () => {
    expect(resolve(index, 'm-free', { suffixes: [freeDash] }).kind).toBe('resolved')
  })

  it('disables all rules for an empty list', () => {
    const provider = gated('m-free', { suffixes: [] })
    expect(resolve(index, 'm-free', { provider, suffixes: [freeDash] })).toEqual({
      kind: 'unresolved',
      reason: 'rules-disabled',
    })
  })

  it('allows only the named rules', () => {
    const provider = gated('m-free', { suffixes: ['free-colon'] })
    expect(resolve(index, 'm-free', { provider, suffixes: [freeDash, freeColon] }).kind).toBe('unresolved')

    const permitted = gated('m-free', { suffixes: ['free-dash'] })
    expect(resolve(index, 'm-free', { provider: permitted, suffixes: [freeDash, freeColon] }).kind).toBe('resolved')
  })

  it('skips a model outright', () => {
    const provider = gated('m', { skip: true })
    expect(resolve(index, 'm', { provider })).toEqual({ kind: 'unresolved', reason: 'skipped' })
  })
})

describe('rule overrides', () => {
  const index = makeIndex([
    { id: 'x/m', cost: { input: 5, output: 10, cacheRead: 0, cacheWrite: 0 } },
    { id: 'x/m-free', cost: { input: 5, output: 10, cacheRead: 0, cacheWrite: 0 } },
  ])

  it('reports the rule only when it was used for the match', () => {
    const direct = resolve(index, 'm-free', { suffixes: [freeDash] })
    expect(direct.kind === 'resolved' && direct.suffixRule).toBeUndefined()

    const stripped = resolve(index, 'm-gratis', { suffixes: [suffixRule('gratis', '-gratis', FREE)] })
    expect(stripped.kind === 'resolved' && stripped.suffixRule?.override).toEqual(FREE)
  })
})

describe('tie-break', () => {
  const shared = [
    { source: 'pi.dev' as const, provider: 'openai', id: 'gpt-5.5', contextWindow: 400_000 },
    { source: 'pi.dev' as const, provider: 'azure', id: 'gpt-5.5', contextWindow: 200_000 },
  ]

  it('tier 1 uses the configured catalog provider', () => {
    const result = resolve(makeIndex(shared), 'gpt-5.5', {
      provider: makeProvider({ catalogProvider: 'azure' }),
    })
    expect(result.kind === 'resolved' && result.entry.sourceProvider).toBe('azure')
  })

  it('tier 2 uses the Pi provider id when it names a catalog provider', () => {
    const result = resolve(makeIndex(shared), 'gpt-5.5', { provider: makeProvider({ id: 'openai' }) })
    expect(result.kind === 'resolved' && result.entry.sourceProvider).toBe('openai')
  })

  it('a vendor prefix in the id settles the provider before any tie-break', () => {
    const result = resolve(makeIndex(shared), 'azure/gpt-5.5')
    expect(result.kind === 'resolved' && result.entry.sourceProvider).toBe('azure')
  })

  it('beats the vendor oracle, which points the other way', () => {
    // The oracle would say `openai`; the explicit prefix must win.
    const index = makeIndex([...shared, { source: 'models.dev', id: 'openai/gpt-5.5' }])
    const result = resolve(index, 'azure/gpt-5.5')
    expect(result.kind === 'resolved' && result.entry.sourceProvider).toBe('azure')
  })

  it('reports vendor-qualified when the stripped id is what matched', () => {
    // pi.dev files this model under `google-vertex`, so `google/…` only resolves
    // once the vendor prefix comes off.
    const index = makeIndex([{ source: 'pi.dev', provider: 'google-vertex', id: 'gemini-3-pro' }])
    const result = resolve(index, 'google/gemini-3-pro')
    expect(result).toMatchObject({ kind: 'resolved', matchKind: 'vendor-qualified' })
  })

  it('falls back to the models.dev vendor oracle when nothing else decides', () => {
    const index = makeIndex([...shared, { source: 'models.dev', id: 'openai/gpt-5.5', contextWindow: 400_000 }])
    const result = resolve(index, 'gpt-5.5')
    expect(result.kind === 'resolved' && result.entry.sourceProvider).toBe('openai')
  })

  it('accepts a single candidate without needing a tie-break', () => {
    const index = makeIndex([{ source: 'pi.dev', provider: 'openai', id: 'gpt-5.5' }])
    expect(resolve(index, 'gpt-5.5').kind).toBe('resolved')
  })

  it('stays ambiguous and injects nothing when every tier is exhausted', () => {
    const result = resolve(makeIndex(shared), 'gpt-5.5')
    expect(result.kind).toBe('ambiguous')
    expect(result.kind === 'ambiguous' && result.candidates).toHaveLength(2)
  })
})

describe('source priority', () => {
  const specs = [
    { source: 'models.dev' as const, id: 'openai/gpt-5.5', contextWindow: 111 },
    { source: 'pi.dev' as const, provider: 'openai', id: 'gpt-5.5', contextWindow: 222 },
  ]

  it('prefers pi.dev by default', () => {
    const result = resolve(makeIndex(specs), 'gpt-5.5', { provider: makeProvider({ id: 'openai' }) })
    expect(result.kind === 'resolved' && result.entry.source).toBe('pi.dev')
  })

  it('follows an inverted source order', () => {
    const index = makeIndex(specs, ['models.dev', 'pi.dev'])
    const result = resolve(index, 'gpt-5.5', { provider: makeProvider({ id: 'openai' }) })
    expect(result.kind === 'resolved' && result.entry.source).toBe('models.dev')
  })

  it('offers a same-provider pi.dev donor for structural backfill', () => {
    const index = makeIndex(specs, ['models.dev', 'pi.dev'])
    const result = resolve(index, 'gpt-5.5', { provider: makeProvider({ id: 'openai' }) })
    expect(result.kind === 'resolved' && result.donor?.source).toBe('pi.dev')
  })
})

describe('determinism', () => {
  it('does not depend on insertion order', () => {
    const specs = [
      { source: 'pi.dev' as const, provider: 'openai', id: 'gpt-5.5', contextWindow: 400_000 },
      { source: 'models.dev' as const, id: 'openai/gpt-5.5', contextWindow: 300_000 },
      { source: 'pi.dev' as const, provider: 'openai', id: 'gpt-5.5-mini' },
    ]
    const forward = resolve(makeIndex(specs), 'gpt-5.5', { provider: makeProvider({ id: 'openai' }) })
    const reversed = resolve(makeIndex([...specs].reverse()), 'gpt-5.5', { provider: makeProvider({ id: 'openai' }) })
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed))
  })
})

describe('misses', () => {
  it('returns unresolved rather than throwing on an unknown id', () => {
    expect(resolve(makeIndex([{ id: 'x/m' }]), 'nothing-like-this')).toEqual({
      kind: 'unresolved',
      reason: 'no-match',
    })
  })
})
