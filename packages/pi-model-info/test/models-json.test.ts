import { describe, expect, it } from 'vitest'
import { readUserAuthoredFields } from '../src/models-json.js'

function read(contents: unknown): ReturnType<typeof readUserAuthoredFields> {
  return readUserAuthoredFields('/agent', () => JSON.stringify(contents))
}

describe('hand-written models.json fields', () => {
  it('records only the fields this extension would otherwise overwrite', () => {
    const authored = read({
      providers: {
        relay: {
          baseUrl: 'http://localhost:8317/v1',
          models: [{ id: 'gpt-5.5', contextWindow: 200_000, baseUrl: 'ignored', api: 'ignored' }],
        },
      },
    })
    expect(authored.get('relay')?.get('gpt-5.5')).toEqual(new Set(['contextWindow']))
  })

  // A definition with no tracked fields still says models.json defines this provider's list, which
  // is what rules out completing it through a lazy wrapper.
  it('records a model with no tracked fields as authoring nothing', () => {
    const authored = read({ providers: { relay: { models: [{ id: 'gpt-5.5' }] } } })
    expect(authored.get('relay')?.get('gpt-5.5')).toEqual(new Set())
  })

  it('ignores an empty or missing models array', () => {
    expect(read({ providers: { relay: { models: [] } } }).size).toBe(0)
    expect(read({ providers: { relay: {} } }).size).toBe(0)
  })

  it('returns nothing for a missing, unreadable or malformed file', () => {
    expect(readUserAuthoredFields('/agent', () => undefined).size).toBe(0)
    expect(
      readUserAuthoredFields('/agent', () => {
        throw new Error('EACCES')
      }).size,
    ).toBe(0)
    expect(readUserAuthoredFields('/agent', () => 'not json').size).toBe(0)
    expect(read({ providers: 'nope' }).size).toBe(0)
  })

  it('skips entries without a string id', () => {
    const authored = read({ providers: { relay: { models: [{ contextWindow: 1 }, { id: 'ok', maxTokens: 2 }] } } })
    expect([...(authored.get('relay')?.keys() ?? [])]).toEqual(['ok'])
  })
})
