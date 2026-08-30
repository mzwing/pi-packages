import type {
  CatalogEntry,
  MetadataOverride,
  ModelCost,
  ModelCostTier,
  ModelInput,
  NormalizedSource,
  ThinkingLevelMapInput,
} from './types.js'
import { compact } from './compact.js'
import { THINKING_LEVELS } from './types.js'

export const PI_DEV_URL = 'https://pi.dev/api/models'
export const MODELS_DEV_URL = 'https://models.dev/models.json'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Remote JSON delivers `__proto__` and friends as ordinary own keys; dropping them keeps them out of index keys. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function entriesOf(value: unknown): [string, unknown][] {
  if (!isRecord(value)) {
    return []
  }

  return Object.entries(value).filter(([key]) => !FORBIDDEN_KEYS.has(key))
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function flag(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function bareId(id: string): string {
  const separator = id.indexOf('/')

  return separator > 0 && separator < id.length - 1 ? id.slice(separator + 1) : id
}

export function vendorOf(id: string): string | undefined {
  const separator = id.indexOf('/')

  return separator > 0 && separator < id.length - 1 ? id.slice(0, separator) : undefined
}

/** Pi accepts only `text` and `image`; absent modalities mean "unknown", not "text only". */
function toModelInput(modalities: unknown): ModelInput | undefined {
  if (!isRecord(modalities) || !Array.isArray(modalities['input'])) {
    return undefined
  }
  const declared = new Set(modalities['input'].filter((value): value is string => typeof value === 'string'))
  const input: ModelInput = ['text']
  if (declared.has('image')) {
    input.push('image')
  }

  return input
}

function toCost(raw: unknown): ModelCost | undefined {
  if (!isRecord(raw)) {
    return undefined
  }
  const input = nonNegative(raw['input'])
  const output = nonNegative(raw['output'])
  if (input === undefined || output === undefined) {
    return undefined
  }

  return compact<ModelCost>({
    input,
    output,
    cacheRead: nonNegative(raw['cacheRead'] ?? raw['cache_read']) ?? 0,
    cacheWrite: nonNegative(raw['cacheWrite'] ?? raw['cache_write']) ?? 0,
    tiers: toTiers(raw),
  })
}

function toTier(raw: unknown, fallbackThreshold?: number): ModelCostTier | undefined {
  if (!isRecord(raw)) {
    return undefined
  }
  const input = nonNegative(raw['input'])
  const output = nonNegative(raw['output'])
  const above =
    positiveInt(raw['inputTokensAbove']) ??
    (isRecord(raw['tier']) ? positiveInt(raw['tier']['size']) : undefined) ??
    fallbackThreshold
  if (input === undefined || output === undefined || above === undefined) {
    return undefined
  }

  return {
    input,
    output,
    cacheRead: nonNegative(raw['cacheRead'] ?? raw['cache_read']) ?? 0,
    cacheWrite: nonNegative(raw['cacheWrite'] ?? raw['cache_write']) ?? 0,
    inputTokensAbove: above,
  }
}

function toTiers(raw: Record<string, unknown>): ModelCostTier[] | undefined {
  if (Array.isArray(raw['tiers'])) {
    const tiers: ModelCostTier[] = []
    for (const entry of raw['tiers'] as unknown[]) {
      const tier = toTier(entry)
      if (tier !== undefined) {
        tiers.push(tier)
      }
    }

    return tiers.length > 0 ? tiers : undefined
  }

  // `context_over_200k` is models.dev's deprecated single-tier spelling, duplicating `tiers[0]` when both are present.
  const legacy = toTier(raw['context_over_200k'], 200_000)

  return legacy === undefined ? undefined : [legacy]
}

function toThinkingLevelMap(raw: unknown): ThinkingLevelMapInput | undefined {
  if (!isRecord(raw)) {
    return undefined
  }
  const map: ThinkingLevelMapInput = {}
  let mapped = false
  for (const level of THINKING_LEVELS) {
    const value = raw[level]
    if (typeof value === 'string' || value === null) {
      map[level] = value
      mapped = true
    }
  }

  return mapped ? map : undefined
}

/**
 * models.dev describes reasoning as options rather than a level map. Only the `effort` form maps to
 * the strings Pi sends; `toggle` and `budget_tokens` carry no level names, and inventing one is a
 * 400 on every turn.
 */
function reasoningOptionsToThinkingLevelMap(raw: unknown): ThinkingLevelMapInput | undefined {
  if (!Array.isArray(raw)) {
    return undefined
  }
  const effort = raw.find(
    (option): option is Record<string, unknown> =>
      isRecord(option) && option['type'] === 'effort' && Array.isArray(option['values']),
  )
  if (effort === undefined) {
    return undefined
  }
  const values = new Set((effort['values'] as unknown[]).filter((value): value is string => typeof value === 'string'))
  const map: ThinkingLevelMapInput = {}
  let mapped = false
  for (const level of THINKING_LEVELS) {
    // models.dev spells Pi's `off` as `none`; the rest are identical.
    const name = level === 'off' ? 'none' : level
    if (values.has(name)) {
      map[level] = name
      mapped = true
    }
  }

  return mapped ? map : undefined
}

/** `{ providerId: { modelId: Model } }`, already in Pi's own shape. */
export function normalizePiDev(payload: unknown): NormalizedSource {
  const entries: CatalogEntry[] = []

  for (const [providerId, models] of entriesOf(payload)) {
    for (const [modelId, raw] of entriesOf(models)) {
      if (!isRecord(raw)) {
        continue
      }
      const id = text(raw['id']) ?? modelId
      const input = Array.isArray(raw['input'])
        ? raw['input'].filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
        : undefined

      entries.push(
        compact<CatalogEntry>({
          source: 'pi.dev',
          sourceProvider: providerId,
          sourceId: id,
          canonicalId: `${providerId}/${id}`,
          api: text(raw['api']),
          metadata: compact<MetadataOverride>({
            name: text(raw['name']),
            reasoning: flag(raw['reasoning']),
            input: input === undefined || input.length === 0 ? undefined : input,
            cost: toCost(raw['cost']),
            contextWindow: positiveInt(raw['contextWindow']),
            maxTokens: positiveInt(raw['maxTokens']),
            thinkingLevelMap: toThinkingLevelMap(raw['thinkingLevelMap']),
            compat: isRecord(raw['compat']) ? raw['compat'] : undefined,
          }),
        }),
      )
    }
  }

  return { source: 'pi.dev', entries, vendors: new Map() }
}

/** `{ "vendor/model": metadata }` — provider-agnostic, and carries no pricing. */
export function normalizeModelsDev(payload: unknown): NormalizedSource {
  const entries: CatalogEntry[] = []
  const vendors = new Map<string, string>()

  for (const [key, raw] of entriesOf(payload)) {
    if (!isRecord(raw)) {
      continue
    }
    const canonicalId = text(raw['id']) ?? key
    const vendor = vendorOf(canonicalId)
    const bare = bareId(canonicalId)
    if (vendor !== undefined) {
      vendors.set(bare.toLowerCase(), vendor)
    }
    const limit = isRecord(raw['limit']) ? raw['limit'] : undefined

    entries.push({
      source: 'models.dev',
      sourceProvider: vendor,
      sourceId: bare,
      canonicalId,
      metadata: compact<MetadataOverride>({
        name: text(raw['name']),
        reasoning: flag(raw['reasoning']),
        input: toModelInput(raw['modalities']),
        contextWindow: limit === undefined ? undefined : positiveInt(limit['context']),
        maxTokens: limit === undefined ? undefined : positiveInt(limit['output']),
        thinkingLevelMap: reasoningOptionsToThinkingLevelMap(raw['reasoning_options']),
      }),
    })
  }

  return { source: 'models.dev', entries, vendors }
}
