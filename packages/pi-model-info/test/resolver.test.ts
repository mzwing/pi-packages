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

function gated(modelId: string, gate: ModelGate): ResolvedProvider {
  return makeProvider({ models: new Map([[modelId, gate]]) })
}

function canonical(result: Resolution): string | undefined {
  return result.kind === 'resolved' ? result.entry.canonicalId : undefined
}

it('lets an alias win over an exact match, and reports a miss rather than falling through', () => {
  const index = makeIndex([{ id: 'openai/gpt-5.6-sol' }, { id: 'openai/gpt-special' }])

  const aliased = resolve(index, 'gpt-special', { provider: gated('gpt-special', { alias: 'openai/gpt-5.6-sol' }) })
  expect(aliased).toMatchObject({ kind: 'resolved', matchKind: 'alias' })
  expect(canonical(aliased)).toBe('openai/gpt-5.6-sol')

  // Falling through would hide the typo forever behind a plausible result.
  const provider = gated('gpt-special', { alias: 'openai/does-not-exist' })
  expect(resolve(index, 'gpt-special', { provider })).toEqual({ kind: 'unresolved', reason: 'alias-miss' })
})

describe('affix stripping', () => {
  // Catalogs really do carry `:free` variants as separate entries with their own pricing.
  it('tries the original id before stripping anything', () => {
    const index = makeIndex([{ id: 'deepseek/r1' }, { id: 'deepseek/r1:free' }])

    expect(resolve(index, 'r1:free', { suffixes: [freeColon] })).toMatchObject({ matchKind: 'exact' })
    expect(canonical(resolve(index, 'r1:free', { suffixes: [freeColon] }))).toBe('deepseek/r1:free')
    expect(resolve(index, 'r1-free', { suffixes: [freeDash] })).toMatchObject({ matchKind: 'stripped' })
  })

  it('removes at most one prefix and one suffix', () => {
    expect(canonical(resolve(makeIndex([{ id: 'x/m-free' }]), 'm-free-free', { suffixes: [freeDash] }))).toBe(
      'x/m-free',
    )
    expect(resolve(makeIndex([{ id: 'x/m' }]), 'm:free-free', { suffixes: [freeDash, freeColon] }).kind).toBe(
      'unresolved',
    )
    expect(
      resolve(makeIndex([{ id: 'x/m' }]), 'beta-m-free', {
        prefixes: [prefixRule('beta', 'beta-')],
        suffixes: [freeDash],
      }),
    ).toMatchObject({ kind: 'resolved', prefixRule: { id: 'beta' }, suffixRule: { id: 'free-dash' } })
  })

  it('tries a single strip before a double strip', () => {
    // `m-preview` exists, so `-preview` must survive when only `-free` was needed.
    const index = makeIndex([{ id: 'x/m' }, { id: 'x/m-preview' }])

    expect(canonical(resolve(index, 'm-preview-free', { suffixes: [freeDash] }))).toBe('x/m-preview')
  })

  it('reports a rule, and so its override, only when the rule was used for the match', () => {
    const index = makeIndex([{ id: 'x/m' }, { id: 'x/m-free' }])

    expect(resolve(index, 'm-free', { suffixes: [freeDash] })).toMatchObject({ suffixRule: undefined })
    expect(resolve(index, 'm-gratis', { suffixes: [suffixRule('gratis', '-gratis', FREE)] })).toMatchObject({
      suffixRule: { override: FREE },
    })
  })

  it('lets a model gate disable every rule with [] or allow only the named ones', () => {
    const index = makeIndex([{ id: 'x/m' }])
    const rules = { suffixes: [freeDash, freeColon] }

    expect(resolve(index, 'm-free', { provider: gated('m-free', { suffixes: [] }), ...rules })).toEqual({
      kind: 'unresolved',
      reason: 'rules-disabled',
    })
    expect(resolve(index, 'm-free', { provider: gated('m-free', { suffixes: ['free-colon'] }), ...rules }).kind).toBe(
      'unresolved',
    )
    expect(resolve(index, 'm-free', { provider: gated('m-free', { suffixes: ['free-dash'] }), ...rules }).kind).toBe(
      'resolved',
    )
  })
})

describe('tie-break between catalog providers', () => {
  const shared = [
    { provider: 'openai', id: 'gpt-5.5' },
    { provider: 'azure', id: 'gpt-5.5' },
  ]
  const provider = (result: Resolution): string | undefined =>
    result.kind === 'resolved' ? result.entry.sourceProvider : undefined

  it('prefers the configured catalog provider, then the Pi provider id', () => {
    const index = makeIndex(shared)

    expect(provider(resolve(index, 'gpt-5.5', { provider: makeProvider({ catalogProvider: 'azure' }) }))).toBe('azure')
    expect(provider(resolve(index, 'gpt-5.5', { provider: makeProvider({ id: 'openai' }) }))).toBe('openai')
  })

  it('lets a vendor prefix in the id settle the provider, even against the vendor oracle', () => {
    const index = makeIndex([...shared, { source: 'models.dev', id: 'openai/gpt-5.5' }])

    expect(provider(resolve(index, 'azure/gpt-5.5'))).toBe('azure')
  })

  it('resolves a vendor-qualified id that the catalog files under another provider', () => {
    const index = makeIndex([{ provider: 'google-vertex', id: 'gemini-3-pro' }])

    expect(resolve(index, 'google/gemini-3-pro')).toMatchObject({ kind: 'resolved', matchKind: 'vendor-qualified' })
  })

  it('falls back to the models.dev vendor oracle, and stays ambiguous when nothing decides', () => {
    expect(provider(resolve(makeIndex([...shared, { source: 'models.dev', id: 'openai/gpt-5.5' }]), 'gpt-5.5'))).toBe(
      'openai',
    )
    expect(resolve(makeIndex(shared), 'gpt-5.5')).toMatchObject({ kind: 'ambiguous', candidates: { length: 2 } })
  })
})

it('follows the configured source order and offers a pi.dev donor for structural backfill', () => {
  const specs = [
    { source: 'models.dev' as const, id: 'openai/gpt-5.5' },
    { source: 'pi.dev' as const, provider: 'openai', id: 'gpt-5.5' },
  ]
  const openai = { provider: makeProvider({ id: 'openai' }) }

  expect(resolve(makeIndex(specs), 'gpt-5.5', openai)).toMatchObject({ entry: { source: 'pi.dev' } })
  expect(resolve(makeIndex(specs, ['models.dev', 'pi.dev']), 'gpt-5.5', openai)).toMatchObject({
    entry: { source: 'models.dev' },
    donor: { source: 'pi.dev' },
  })
})
