import type { ReviewModelRegistry } from '../src/model.js'
import type { Api, Model, Provider } from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'
import { autoReviewConfigSchema } from '../src/config.js'
import { resolveReviewModel } from '../src/model.js'

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    reasoning: true,
    input: ['text', 'image'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 32_000,
    ...overrides,
  }
}

function registry(models: Model<Api>[], provider: Provider): ReviewModelRegistry {
  return {
    find: vi.fn((providerId, modelId) =>
      models.find(candidate => candidate.provider === providerId && candidate.id === modelId),
    ),
    getAll: vi.fn(() => models),
    getProvider: vi.fn(providerId => (providerId === provider.id ? provider : undefined)),
    getApiKeyAndHeaders: vi.fn(),
  }
}

describe('resolveReviewModel', () => {
  it('synthesizes the hidden Codex reviewer from a Codex provider model', () => {
    const template = model()
    const provider = {
      id: 'openai-codex',
      getModels: () => [template],
    } as unknown as Provider

    const result = resolveReviewModel(registry([template], provider), autoReviewConfigSchema.parse({}))

    expect(result).toMatchObject({
      ok: true,
      value: {
        synthesized: true,
        model: {
          id: 'codex-auto-review',
          api: 'openai-codex-responses',
          provider: 'openai-codex',
          input: ['text'],
        },
      },
    })
  })

  it('requires custom models to exist in Pi model registry', () => {
    const provider = {
      id: 'custom',
      getModels: () => [],
    } as unknown as Provider
    const config = autoReviewConfigSchema.parse({
      provider: 'custom',
      model: 'codex-auto-review',
    })

    expect(resolveReviewModel(registry([], provider), config)).toEqual({
      ok: false,
      category: 'model-unresolved',
    })
  })
})
