import type { CatalogEntry, Resolution } from '../src/types.js'
import { describe, expect, it } from 'vitest'
import { mergeMetadata } from '../src/merge.js'
import { entry, makeProvider, makeSnapshot, suffixRule } from './helpers.js'

function resolved(spec: Parameters<typeof entry>[0], donor?: CatalogEntry): Resolution {
  return {
    kind: 'resolved',
    entry: entry(spec),
    donor,
    matchKind: 'exact',
    prefixRule: undefined,
    suffixRule: undefined,
  }
}

const UNRESOLVED: Resolution = { kind: 'unresolved', reason: 'no-match' }

describe('unresolved models', () => {
  it('reproduces the existing metadata exactly', () => {
    const snapshot = makeSnapshot({ contextWindow: 200_000, reasoning: true, input: ['text', 'image'] })
    const { model } = mergeMetadata({
      snapshot,
      provider: makeProvider(),
      resolution: UNRESOLVED,
      gate: undefined,
    })
    expect(model).toMatchObject({
      id: snapshot.id,
      name: snapshot.name,
      api: snapshot.api,
      baseUrl: snapshot.baseUrl,
      contextWindow: 200_000,
      maxTokens: snapshot.maxTokens,
      reasoning: true,
      input: ['text', 'image'],
      cost: snapshot.cost,
    })
  })
})

describe('identity and carried fields', () => {
  it('pins api and baseUrl and carries headers, compat and samplingParams', () => {
    const snapshot = makeSnapshot({
      headers: { 'x-relay': '1' },
      samplingParams: { top_p: 0.9 },
      compat: { supportsStrictMode: true } as never,
    })
    const { model } = mergeMetadata({
      snapshot,
      provider: makeProvider(),
      resolution: resolved({ id: 'openai/gpt-5.5', contextWindow: 400_000 }),
      gate: undefined,
    })
    expect(model.api).toBe(snapshot.api)
    expect(model.baseUrl).toBe(snapshot.baseUrl)
    expect(model.headers).toEqual({ 'x-relay': '1' })
    expect(model.samplingParams).toEqual({ top_p: 0.9 })
    expect(model.compat).toEqual({ supportsStrictMode: true })
  })
})

describe('cost', () => {
  const catalogCost = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 }

  it('takes the catalog rates', () => {
    const { model } = mergeMetadata({
      snapshot: makeSnapshot(),
      provider: makeProvider(),
      resolution: resolved({ id: 'openai/gpt-5.5', cost: catalogCost }),
      gate: undefined,
    })
    expect(model.cost).toEqual(catalogCost)
  })

  it('merges a partial override field-wise and replaces tiers wholesale', () => {
    const tiers = [{ input: 10, output: 45, cacheRead: 1, cacheWrite: 0, inputTokensAbove: 272_000 }]
    const { model } = mergeMetadata({
      snapshot: makeSnapshot(),
      provider: makeProvider(),
      resolution: resolved({ id: 'openai/gpt-5.5', cost: { ...catalogCost, tiers: [] } }),
      gate: { override: { cost: { output: 99, tiers } } },
    })
    expect(model.cost).toEqual({ input: 5, output: 99, cacheRead: 0.5, cacheWrite: 6.25, tiers })
  })

  it('scales catalog pricing but not a rule that sets zero', () => {
    const provider = makeProvider({ costMultiplier: 2 })
    const scaled = mergeMetadata({
      snapshot: makeSnapshot(),
      provider,
      resolution: resolved({ id: 'openai/gpt-5.5', cost: catalogCost }),
      gate: undefined,
    })
    expect(scaled.model.cost.input).toBe(10)

    const free = suffixRule('free-dash', '-free', { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })
    const withRule = mergeMetadata({
      snapshot: makeSnapshot(),
      provider,
      resolution: {
        ...resolved({ id: 'openai/gpt-5.5', cost: catalogCost }),
        matchKind: 'stripped',
        suffixRule: free,
      } as Resolution,
      gate: undefined,
    })
    expect(withRule.model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  it('leaves cost untouched when the winner is models.dev, which has none', () => {
    const snapshot = makeSnapshot({ cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } })
    const { model } = mergeMetadata({
      snapshot,
      provider: makeProvider(),
      resolution: resolved({ source: 'models.dev', id: 'openai/gpt-5.5', contextWindow: 400_000 }),
      gate: undefined,
    })
    expect(model.cost).toEqual(snapshot.cost)
    expect(model.contextWindow).toBe(400_000)
  })

  it('honours costPolicy zero and keep', () => {
    const base = {
      snapshot: makeSnapshot(),
      resolution: resolved({ id: 'openai/gpt-5.5', cost: catalogCost }),
      gate: undefined,
    }
    expect(mergeMetadata({ ...base, provider: makeProvider({ costPolicy: 'zero' }) }).model.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
    expect(mergeMetadata({ ...base, provider: makeProvider({ costPolicy: 'keep' }) }).model.cost).toEqual(
      base.snapshot.cost,
    )
  })
})

describe('limits', () => {
  it('clamps down but never up under the min policy', () => {
    const snapshot = makeSnapshot({ contextWindow: 128_000 })
    const provider = makeProvider({ contextWindowPolicy: 'min' })
    expect(
      mergeMetadata({
        snapshot,
        provider,
        resolution: resolved({ id: 'openai/gpt-5.5', contextWindow: 1_000_000 }),
        gate: undefined,
      }).model.contextWindow,
    ).toBe(128_000)

    expect(
      mergeMetadata({
        snapshot,
        provider,
        resolution: resolved({ id: 'openai/gpt-5.5', contextWindow: 64_000 }),
        gate: undefined,
      }).model.contextWindow,
    ).toBe(64_000)
  })

  it('never lets maxTokens exceed the context window', () => {
    const { model } = mergeMetadata({
      snapshot: makeSnapshot(),
      provider: makeProvider(),
      resolution: resolved({ id: 'openai/gpt-5.5', contextWindow: 8_000, maxTokens: 32_000 }),
      gate: undefined,
    })
    expect(model.maxTokens).toBe(8_000)
  })

  it('reverts an invalid value and records an issue', () => {
    const snapshot = makeSnapshot()
    const { model, issues } = mergeMetadata({
      snapshot,
      provider: makeProvider(),
      resolution: resolved({ id: 'openai/gpt-5.5' }),
      gate: { override: { contextWindow: Number.NaN } },
    })
    expect(model.contextWindow).toBe(snapshot.contextWindow)
    expect(issues).toHaveLength(1)
  })
})

describe('capabilities', () => {
  const snapshot = makeSnapshot({ input: ['text', 'image'], reasoning: true })

  it('replaces under the catalog policy', () => {
    const { model } = mergeMetadata({
      snapshot,
      provider: makeProvider(),
      resolution: resolved({ id: 'openai/gpt-5.5', input: ['text'], reasoning: false }),
      gate: undefined,
    })
    expect(model.input).toEqual(['text'])
    expect(model.reasoning).toBe(false)
  })

  it('only ever adds under the widen policy', () => {
    const { model } = mergeMetadata({
      snapshot,
      provider: makeProvider({ capabilityPolicy: 'widen' }),
      resolution: resolved({ id: 'openai/gpt-5.5', input: ['text'], reasoning: false }),
      gate: undefined,
    })
    expect(model.input).toEqual(['text', 'image'])
    expect(model.reasoning).toBe(true)
  })

  it('ignores the catalog under the keep policy', () => {
    const { model } = mergeMetadata({
      snapshot: makeSnapshot(),
      provider: makeProvider({ capabilityPolicy: 'keep' }),
      resolution: resolved({ id: 'openai/gpt-5.5', input: ['text', 'image'], reasoning: true }),
      gate: undefined,
    })
    expect(model.input).toEqual(['text'])
    expect(model.reasoning).toBe(false)
  })
})

describe('thinkingLevelMap', () => {
  it('shallow-merges and keeps an explicit null distinct from omission', () => {
    const snapshot = makeSnapshot({ thinkingLevelMap: { low: 'low', high: 'high' } })
    const { model } = mergeMetadata({
      snapshot,
      provider: makeProvider(),
      resolution: resolved({ id: 'openai/gpt-5.5', thinkingLevelMap: { high: null, max: 'max' } }),
      gate: undefined,
    })
    expect(model.thinkingLevelMap).toEqual({ low: 'low', high: null, max: 'max' })
  })

  it('ignores a models.dev map unless mapThinkingLevels is on', () => {
    const map = { low: 'low', high: 'high' }
    const off = mergeMetadata({
      snapshot: makeSnapshot(),
      provider: makeProvider(),
      resolution: resolved({ source: 'models.dev', id: 'openai/gpt-5.5', thinkingLevelMap: map }),
      gate: undefined,
    })
    expect(off.model.thinkingLevelMap).toBeUndefined()

    const on = mergeMetadata({
      snapshot: makeSnapshot(),
      provider: makeProvider({ mapThinkingLevels: true }),
      resolution: resolved({ source: 'models.dev', id: 'openai/gpt-5.5', thinkingLevelMap: map }),
      gate: undefined,
    })
    expect(on.model.thinkingLevelMap).toEqual(map)
  })

  it('backfills from a pi.dev donor even when the winner is models.dev', () => {
    const donor = entry({ source: 'pi.dev', provider: 'openai', id: 'gpt-5.5', thinkingLevelMap: { high: 'high' } })
    const { model } = mergeMetadata({
      snapshot: makeSnapshot(),
      provider: makeProvider(),
      resolution: resolved({ source: 'models.dev', id: 'openai/gpt-5.5' }, donor),
      gate: undefined,
    })
    expect(model.thinkingLevelMap).toEqual({ high: 'high' })
  })
})

describe('compat', () => {
  it('copies only when the donor api matches the target', () => {
    const compat = { supportsStrictMode: true } as never
    const matching = mergeMetadata({
      snapshot: makeSnapshot(),
      provider: makeProvider(),
      resolution: resolved({ id: 'openai/gpt-5.5', api: 'openai-completions', compat }),
      gate: undefined,
    })
    expect(matching.model.compat).toEqual({ supportsStrictMode: true })

    const mismatched = mergeMetadata({
      snapshot: makeSnapshot(),
      provider: makeProvider(),
      resolution: resolved({ id: 'openai/gpt-5.5', api: 'anthropic-messages', compat }),
      gate: undefined,
    })
    expect(mismatched.model.compat).toBeUndefined()
  })
})

describe('name', () => {
  it('keeps the existing name unless useCatalogName is set', () => {
    const base = {
      snapshot: makeSnapshot({ name: 'relay-name' }),
      resolution: resolved({ id: 'openai/gpt-5.5', name: 'GPT-5.5' }),
      gate: undefined,
    }
    expect(mergeMetadata({ ...base, provider: makeProvider() }).model.name).toBe('relay-name')
    expect(mergeMetadata({ ...base, provider: makeProvider({ useCatalogName: true }) }).model.name).toBe('GPT-5.5')
  })
})

describe('hand-written models.json fields', () => {
  it('are not overwritten by the catalog, but an explicit override still wins', () => {
    const snapshot = makeSnapshot({ contextWindow: 200_000 })
    const automatic = mergeMetadata({
      snapshot,
      provider: makeProvider(),
      resolution: resolved({ id: 'openai/gpt-5.5', contextWindow: 1_000_000 }),
      gate: undefined,
      userAuthored: new Set(['contextWindow']),
    })
    expect(automatic.model.contextWindow).toBe(200_000)
    expect(automatic.provenance.get('contextWindow')).toBe('models.json')

    const explicit = mergeMetadata({
      snapshot,
      provider: makeProvider(),
      resolution: resolved({ id: 'openai/gpt-5.5', contextWindow: 1_000_000 }),
      gate: { override: { contextWindow: 500_000 } },
      userAuthored: new Set(['contextWindow']),
    })
    expect(explicit.model.contextWindow).toBe(500_000)
  })
})

describe('output shape', () => {
  it('omits optional keys rather than setting them undefined', () => {
    const { model } = mergeMetadata({
      snapshot: makeSnapshot(),
      provider: makeProvider(),
      resolution: resolved({ id: 'openai/gpt-5.5' }),
      gate: undefined,
    })
    for (const [key, value] of Object.entries(model)) {
      expect(value, `${key} should be omitted rather than undefined`).not.toBeUndefined()
    }
  })
})
