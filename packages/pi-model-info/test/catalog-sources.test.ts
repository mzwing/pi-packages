import { describe, expect, it } from 'vitest'
import { bareId, normalizeModelsDev, normalizePiDev, vendorOf } from '../src/catalog-sources.js'

function modelsDev(entry: Record<string, unknown>, key = 'openai/gpt-5.5'): Record<string, unknown> {
  return { [key]: { id: key, name: 'GPT-5.5', ...entry } }
}

describe('id helpers', () => {
  it('splits only on the first separator', () => {
    expect(vendorOf('openai/gpt-5.5')).toBe('openai')
    expect(bareId('openrouter/nvidia/nemotron')).toBe('nvidia/nemotron')
  })

  it('treats an id without a usable separator as bare', () => {
    expect(vendorOf('gpt-5.5')).toBeUndefined()
    expect(vendorOf('/leading')).toBeUndefined()
    expect(bareId('trailing/')).toBe('trailing/')
  })
})

describe('models.dev modalities', () => {
  const inputOf = (modalities: unknown): unknown =>
    normalizeModelsDev(modelsDev({ limit: { context: 1 }, modalities })).entries[0]?.metadata.input

  it('drops modalities Pi cannot express', () => {
    expect(inputOf({ input: ['text', 'image', 'pdf', 'audio', 'video'] })).toEqual(['text', 'image'])
    expect(inputOf({ input: ['text', 'pdf'] })).toEqual(['text'])
  })

  it('always includes text, even when only image is declared', () => {
    expect(inputOf({ input: ['image'] })).toEqual(['text', 'image'])
  })

  it('leaves input unset when modalities are absent', () => {
    // Defaulting to ['text'] would strip image support Pi already knew about.
    expect(inputOf(undefined)).toBeUndefined()
  })
})

describe('models.dev limits', () => {
  it('maps context and output, and invents nothing that is missing', () => {
    const [entry] = normalizeModelsDev(modelsDev({ limit: { context: 400_000, output: 64_000 } })).entries
    expect(entry?.metadata.contextWindow).toBe(400_000)
    expect(entry?.metadata.maxTokens).toBe(64_000)

    const [partial] = normalizeModelsDev(modelsDev({ limit: { context: 400_000 } })).entries
    expect(partial?.metadata.maxTokens).toBeUndefined()
  })

  it('never synthesises cost, which this endpoint does not carry', () => {
    const [entry] = normalizeModelsDev(modelsDev({ limit: { context: 1 } })).entries
    expect(entry?.metadata.cost).toBeUndefined()
  })
})

describe('models.dev reasoning options', () => {
  const mapOf = (reasoning_options: unknown): unknown =>
    normalizeModelsDev(modelsDev({ limit: { context: 1 }, reasoning: true, reasoning_options })).entries[0]?.metadata
      .thinkingLevelMap

  it('maps effort values and spells none as off', () => {
    expect(mapOf([{ type: 'effort', values: ['none', 'low', 'high'] }])).toEqual({
      off: 'none',
      low: 'low',
      high: 'high',
    })
  })

  it('omits levels the provider does not accept rather than marking them unsupported', () => {
    // Omission means "provider default"; null is a much stronger claim.
    expect(mapOf([{ type: 'effort', values: ['low'] }])).toEqual({ low: 'low' })
  })

  it('produces no map for toggle or budget_tokens', () => {
    expect(mapOf([{ type: 'toggle' }])).toBeUndefined()
    expect(mapOf([{ type: 'budget_tokens', min: 1024 }])).toBeUndefined()
  })
})

describe('models.dev vendor oracle', () => {
  it('indexes bare ids to their vendor', () => {
    const source = normalizeModelsDev(modelsDev({ limit: { context: 1 } }))
    expect(source.vendors.get('gpt-5.5')).toBe('openai')
    expect(source.entries[0]?.sourceProvider).toBe('openai')
    expect(source.entries[0]?.canonicalId).toBe('openai/gpt-5.5')
  })
})

describe('pi.dev passthrough', () => {
  const payload = {
    openai: {
      'gpt-5.5': {
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
      },
    },
  }

  it('carries every field through unchanged', () => {
    const [entry] = normalizePiDev(payload).entries
    expect(entry).toMatchObject({
      source: 'pi.dev',
      sourceProvider: 'openai',
      sourceId: 'gpt-5.5',
      canonicalId: 'openai/gpt-5.5',
      api: 'openai-responses',
    })
    expect(entry?.metadata).toEqual({
      name: 'GPT-5.5',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 400_000,
      maxTokens: 128_000,
      thinkingLevelMap: { low: 'low', xhigh: null },
      compat: { supportsStrictMode: true },
    })
  })
})

describe('cost tiers', () => {
  it('reads the tier threshold from either spelling', () => {
    const payload = {
      p: {
        m: {
          id: 'm',
          cost: {
            input: 5,
            output: 30,
            tiers: [{ input: 10, output: 45, cache_read: 1, tier: { type: 'context', size: 272_000 } }],
          },
        },
      },
    }
    const [entry] = normalizePiDev(payload).entries
    expect(entry?.metadata.cost?.tiers).toEqual([
      { input: 10, output: 45, cacheRead: 1, cacheWrite: 0, inputTokensAbove: 272_000 },
    ])
  })

  it('falls back to the deprecated context_over_200k only when tiers are absent', () => {
    const legacy = {
      p: { m: { id: 'm', cost: { input: 2, output: 12, context_over_200k: { input: 4, output: 18 } } } },
    }
    const [entry] = normalizePiDev(legacy).entries
    expect(entry?.metadata.cost?.tiers).toEqual([
      { input: 4, output: 18, cacheRead: 0, cacheWrite: 0, inputTokensAbove: 200_000 },
    ])
  })

  it('drops cost entirely when input or output is missing', () => {
    const [entry] = normalizePiDev({ p: { m: { id: 'm', cost: { input: 5 } } } }).entries
    expect(entry?.metadata.cost).toBeUndefined()
  })
})

describe('hostile payloads', () => {
  it('does not pollute Object.prototype', () => {
    const payload = JSON.parse(
      '{"__proto__":{"polluted":true},"p":{"__proto__":{"polluted":true},"m":{"id":"m"}}}',
    ) as unknown
    normalizePiDev(payload)
    normalizeModelsDev(payload)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('drops one malformed entry without failing the batch', () => {
    const payload = { p: { good: { id: 'good' }, bad: 'not-an-object' } }
    const { entries } = normalizePiDev(payload)
    expect(entries.map(item => item.sourceId)).toEqual(['good'])
  })

  it('returns nothing for a payload that is not an object', () => {
    expect(normalizePiDev('nope').entries).toEqual([])
    expect(normalizeModelsDev([1, 2, 3]).entries).toEqual([])
  })
})
