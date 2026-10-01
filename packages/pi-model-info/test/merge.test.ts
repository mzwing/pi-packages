import type { CatalogEntry, MetadataOverride, ModelGate, ResolvedProvider, SnapshotModel } from '../src/types.js'
import type { EntrySpec } from './helpers.js'
import { describe, expect, it } from 'vitest'
import { mergeMetadata } from '../src/merge.js'
import { entry, makeProvider, makeSnapshot, suffixRule } from './helpers.js'

const CATALOG_COST = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 }

interface MergeCase {
  spec: Partial<EntrySpec>
  provider?: Partial<ResolvedProvider>
  snapshot?: Partial<SnapshotModel>
  gate?: ModelGate
  donor?: CatalogEntry
  suffixOverride?: MetadataOverride
  userAuthored?: string[]
}

function merge({ spec, provider, snapshot, gate, donor, suffixOverride, userAuthored }: MergeCase) {
  return mergeMetadata({
    snapshot: makeSnapshot(snapshot),
    provider: makeProvider({ ...provider, models: new Map(gate === undefined ? [] : [['gpt-5.5', gate]]) }),
    resolution: {
      kind: 'resolved',
      entry: entry({ id: 'openai/gpt-5.5', ...spec }),
      donor,
      matchKind: suffixOverride === undefined ? 'exact' : 'stripped',
      prefixRule: undefined,
      suffixRule: suffixOverride === undefined ? undefined : suffixRule('free-dash', '-free', suffixOverride),
    },
    userAuthored: userAuthored === undefined ? undefined : new Set(userAuthored),
  })
}

describe('cost', () => {
  it('merges a partial override field by field, but replaces tiers wholesale', () => {
    const tiers = [{ input: 10, output: 45, cacheRead: 1, cacheWrite: 0, inputTokensAbove: 272_000 }]
    const { model } = merge({
      spec: { cost: { ...CATALOG_COST, tiers: [] } },
      gate: { override: { cost: { output: 99, tiers } } },
    })

    expect(model.cost).toEqual({ ...CATALOG_COST, output: 99, tiers })
  })

  it('applies a relay markup to catalog pricing, never to a rule that sets zero', () => {
    const free = { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }

    expect(merge({ spec: { cost: CATALOG_COST }, provider: { costMultiplier: 2 } }).model.cost.input).toBe(10)
    expect(
      merge({ spec: { cost: CATALOG_COST }, provider: { costMultiplier: 2 }, suffixOverride: free }).model.cost,
    ).toEqual(free.cost)
  })

  it('leaves the price alone when the winner is models.dev, which carries none', () => {
    const cost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }

    expect(merge({ spec: { source: 'models.dev', contextWindow: 400_000 }, snapshot: { cost } }).model).toMatchObject({
      cost,
      contextWindow: 400_000,
    })
  })
})

describe('limits and capabilities', () => {
  it('never raises a limit under the min policy', () => {
    const provider = { contextWindowPolicy: 'min' as const }

    expect(merge({ spec: { contextWindow: 1_000_000 }, provider }).model.contextWindow).toBe(128_000)
    expect(merge({ spec: { contextWindow: 64_000 }, provider }).model.contextWindow).toBe(64_000)
  })

  it('never lets maxTokens exceed the context window', () => {
    expect(merge({ spec: { contextWindow: 8_000, maxTokens: 32_000 } }).model.maxTokens).toBe(8_000)
  })

  it('only ever adds a capability under the widen policy', () => {
    const { model } = merge({
      spec: { input: ['text'], reasoning: false },
      provider: { capabilityPolicy: 'widen' },
      snapshot: { input: ['text', 'image'], reasoning: true },
    })

    expect(model).toMatchObject({ input: ['text', 'image'], reasoning: true })
  })
})

describe('thinking levels', () => {
  it('merges a level map shallowly, keeping an explicit null distinct from an omitted level', () => {
    const { model } = merge({
      spec: { thinkingLevelMap: { high: null, max: 'max' } },
      snapshot: { thinkingLevelMap: { low: 'low', high: 'high' } },
    })

    expect(model.thinkingLevelMap).toEqual({ low: 'low', high: null, max: 'max' })
  })

  it('uses a map derived from models.dev only when mapThinkingLevels is on', () => {
    const spec = { source: 'models.dev' as const, thinkingLevelMap: { low: 'low', high: 'high' } }

    expect(merge({ spec }).model.thinkingLevelMap).toBeUndefined()
    expect(merge({ spec, provider: { mapThinkingLevels: true } }).model.thinkingLevelMap).toEqual(spec.thinkingLevelMap)
  })

  it('backfills from a pi.dev donor when the winner is models.dev', () => {
    const donor = entry({ provider: 'openai', id: 'gpt-5.5', thinkingLevelMap: { high: 'high' } })

    expect(merge({ spec: { source: 'models.dev' }, donor }).model.thinkingLevelMap).toEqual({ high: 'high' })
  })
})

// `compat` is keyed on `api`, so copying it across APIs is wrong even for the same model.
it('copies compat only when the api matches', () => {
  const compat = { supportsStrictMode: true } as never

  expect(merge({ spec: { api: 'openai-completions', compat } }).model.compat).toEqual(compat)
  expect(merge({ spec: { api: 'anthropic-messages', compat } }).model.compat).toBeUndefined()
})

it('never lets a catalog overwrite a hand-written models.json field, though an explicit override may', () => {
  const automatic = merge({ spec: { contextWindow: 1_000_000 }, userAuthored: ['contextWindow'] })
  expect(automatic.model.contextWindow).toBe(128_000)
  expect(automatic.provenance.get('contextWindow')).toBe('models.json')

  const explicit = merge({
    spec: { contextWindow: 1_000_000 },
    gate: { override: { contextWindow: 500_000 } },
    userAuthored: ['contextWindow'],
  })
  expect(explicit.model.contextWindow).toBe(500_000)
})
