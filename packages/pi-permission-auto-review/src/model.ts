import type { AutoReviewConfig } from './config.js'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { ModelRegistry } from '@earendil-works/pi-coding-agent'
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from './config.js'

export type ResolveReviewModelResult =
  | { ok: true; value: Model<Api> }
  | { ok: false; category: 'provider-unresolved' | 'model-unresolved' }

const CODEX_API = 'openai-codex-responses'

/** `codex-auto-review` is hidden from the registry, so it is derived from another model of the Codex provider. */
export function resolveReviewModel(registry: ModelRegistry, config: AutoReviewConfig): ResolveReviewModelResult {
  const provider = registry.getProvider(config.provider)
  if (provider === undefined) {
    return { ok: false, category: 'provider-unresolved' }
  }
  const registered = registry.find(config.provider, config.model)
  if (registered !== undefined) {
    return { ok: true, value: registered }
  }
  if (config.provider !== DEFAULT_PROVIDER || config.model !== DEFAULT_MODEL) {
    return { ok: false, category: 'model-unresolved' }
  }

  const template =
    registry.getAll().find(model => model.provider === DEFAULT_PROVIDER && model.api === CODEX_API) ??
    provider.getModels().find(model => model.api === CODEX_API)

  return template === undefined
    ? { ok: false, category: 'model-unresolved' }
    : {
        ok: true,
        value: { ...template, id: DEFAULT_MODEL, name: 'Codex Auto Review', reasoning: true, input: ['text'] },
      }
}
