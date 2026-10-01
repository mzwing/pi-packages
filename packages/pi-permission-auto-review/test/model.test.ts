import type { ModelRegistry } from '@earendil-works/pi-coding-agent'
import { expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import { resolveReviewModel } from '../src/model.js'

// `codex-auto-review` never appears in Pi's registry.
it('derives the hidden reviewer model from another Codex model, for the Codex provider only', () => {
  const template = {
    id: 'gpt-5.6-terra',
    provider: 'openai-codex',
    api: 'openai-codex-responses',
    input: ['text', 'image'],
  }
  const registry = {
    getProvider: (id: string) => ({ id, getModels: () => [] }),
    find: () => undefined,
    getAll: () => [template],
  } as unknown as ModelRegistry

  expect(resolveReviewModel(registry, DEFAULT_CONFIG)).toMatchObject({
    ok: true,
    value: { id: 'codex-auto-review', api: 'openai-codex-responses', reasoning: true, input: ['text'] },
  })
  expect(resolveReviewModel(registry, { ...DEFAULT_CONFIG, provider: 'custom' })).toEqual({
    ok: false,
    category: 'model-unresolved',
  })
})
