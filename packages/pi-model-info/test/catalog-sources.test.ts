import { describe, expect, it } from 'vitest'
import { normalizeModelsDev, normalizePiDev } from '../src/catalog-sources.js'

function modelsDev(fields: Record<string, unknown>) {
  return normalizeModelsDev({ 'openai/gpt-5.5': { id: 'openai/gpt-5.5', limit: { context: 1 }, ...fields } }).entries[0]
    ?.metadata
}

describe('models.dev', () => {
  // Defaulting to ['text'] would strip image support Pi already knew about.
  it('keeps only the modalities Pi can express, and leaves input unknown when none are declared', () => {
    expect(modelsDev({ modalities: { input: ['image', 'pdf', 'audio'] } })?.input).toEqual(['text', 'image'])
    expect(modelsDev({})?.input).toBeUndefined()
  })

  // Only the `effort` form names levels Pi can send; inventing one is a 400 on every turn.
  it('maps only effort options, spelling none as off and omitting the levels a model does not accept', () => {
    expect(modelsDev({ reasoning_options: [{ type: 'effort', values: ['none', 'high'] }] })?.thinkingLevelMap).toEqual({
      off: 'none',
      high: 'high',
    })
    expect(modelsDev({ reasoning_options: [{ type: 'budget_tokens', min: 1024 }] })?.thinkingLevelMap).toBeUndefined()
  })
})

describe('pi.dev', () => {
  it("carries an entry through in Pi's own model shape", () => {
    const model = {
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      api: 'openai-responses',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 400_000,
      maxTokens: 128_000,
      thinkingLevelMap: { low: 'low', xhigh: null },
      compat: { supportsStrictMode: true },
    }
    const [entry] = normalizePiDev({ openai: { 'gpt-5.5': model } }).entries

    expect(entry).toEqual({
      source: 'pi.dev',
      sourceProvider: 'openai',
      sourceId: 'gpt-5.5',
      canonicalId: 'openai/gpt-5.5',
      api: 'openai-responses',
      metadata: {
        name: model.name,
        reasoning: true,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        thinkingLevelMap: model.thinkingLevelMap,
        compat: model.compat,
      },
    })
  })

  it('reads a tier threshold in either spelling, and the deprecated context_over_200k only without tiers', () => {
    const tiersOf = (cost: Record<string, unknown>) =>
      normalizePiDev({ p: { m: { id: 'm', cost: { input: 2, output: 12, ...cost } } } }).entries[0]?.metadata.cost
        ?.tiers

    expect(tiersOf({ tiers: [{ input: 10, output: 45, tier: { size: 272_000 } }] })).toEqual([
      { input: 10, output: 45, cacheRead: 0, cacheWrite: 0, inputTokensAbove: 272_000 },
    ])
    expect(tiersOf({ context_over_200k: { input: 4, output: 18 } })).toEqual([
      { input: 4, output: 18, cacheRead: 0, cacheWrite: 0, inputTokensAbove: 200_000 },
    ])
  })
})

describe('hostile payloads', () => {
  it('does not pollute Object.prototype', () => {
    const payload: unknown = JSON.parse('{"__proto__":{"polluted":true},"p":{"__proto__":{"polluted":true}}}')
    normalizePiDev(payload)
    normalizeModelsDev(payload)

    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('drops a malformed entry without failing the rest', () => {
    expect(
      normalizePiDev({ p: { good: { id: 'good' }, bad: 'not-an-object' } }).entries.map(item => item.sourceId),
    ).toEqual(['good'])
  })
})
