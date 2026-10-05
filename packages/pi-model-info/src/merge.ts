import type {
  ChatModelConfig,
  MetadataOverride,
  ModelCost,
  ModelInput,
  Resolution,
  ResolvedMatch,
  ResolvedProvider,
  SnapshotModel,
  ThinkingLevelMap,
  ThinkingLevelMapInput,
} from './types.js'
import { compact } from './util.js'

export interface MergeInput {
  snapshot: SnapshotModel
  provider: ResolvedProvider
  resolution: Resolution
  /** Field names the user hand-wrote in models.json `models[]`, which a catalog never overwrites. */
  userAuthored?: ReadonlySet<string> | undefined
}

export interface MergeOutput {
  model: ChatModelConfig
  /** Field name to the layer that produced its final value. */
  provenance: Map<string, string>
}

const OVERRIDE_FIELDS = [
  'name',
  'reasoning',
  'input',
  'cost',
  'contextWindow',
  'maxTokens',
  'thinkingLevelMap',
  'compat',
] as const

type OverrideField = (typeof OVERRIDE_FIELDS)[number]
type CostOverride = NonNullable<MetadataOverride['cost']>

interface Draft {
  name: string
  reasoning: boolean
  input: ModelInput
  cost: ModelCost
  contextWindow: number
  maxTokens: number
  thinkingLevelMap: ThinkingLevelMapInput | undefined
  compat: SnapshotModel['compat']
}

function isOverrideField(field: string): field is OverrideField {
  return (OVERRIDE_FIELDS as readonly string[]).includes(field)
}

function mergeCost(base: ModelCost, incoming: CostOverride): ModelCost {
  return compact<ModelCost>({
    input: incoming.input ?? base.input,
    output: incoming.output ?? base.output,
    cacheRead: incoming.cacheRead ?? base.cacheRead,
    cacheWrite: incoming.cacheWrite ?? base.cacheWrite,
    tiers: incoming.tiers ?? base.tiers,
  })
}

function unionInput(left: ModelInput, right: ModelInput): ModelInput {
  return [...left, ...right].includes('image') ? ['text', 'image'] : ['text']
}

/** A relay's markup applies to catalog pricing only, never to a rule's explicit `0`. */
function scaleCost(cost: CostOverride, multiplier: number): CostOverride {
  if (multiplier === 1) {
    return cost
  }
  const scale = (value: number | undefined): number | undefined =>
    value === undefined ? undefined : value * multiplier

  return compact<CostOverride>({
    input: scale(cost.input),
    output: scale(cost.output),
    cacheRead: scale(cost.cacheRead),
    cacheWrite: scale(cost.cacheWrite),
    tiers: cost.tiers?.map(tier => ({
      input: tier.input * multiplier,
      output: tier.output * multiplier,
      cacheRead: tier.cacheRead * multiplier,
      cacheWrite: tier.cacheWrite * multiplier,
      inputTokensAbove: tier.inputTokensAbove,
    })),
  })
}

/**
 * Everything comes from the single winning entry, filtered by the provider's policies. Only what the winner's
 * source cannot express is backfilled, and only from a same-provider pi.dev donor.
 */
function catalogLayer(
  { entry, donor }: ResolvedMatch,
  provider: ResolvedProvider,
  snapshot: SnapshotModel,
): MetadataOverride {
  const { metadata } = entry
  const capability = <T>(value: T | undefined, widen: (value: T) => T): T | undefined => {
    if (value === undefined || provider.capabilityPolicy === 'keep') {
      return undefined
    }

    return provider.capabilityPolicy === 'widen' ? widen(value) : value
  }
  const limit = (value: number | undefined, existing: number): number | undefined => {
    if (value === undefined || provider.contextWindowPolicy === 'keep') {
      return undefined
    }

    return provider.contextWindowPolicy === 'min' ? Math.min(value, existing) : value
  }
  const catalogCost =
    provider.costPolicy === 'catalog' && metadata.cost !== undefined
      ? scaleCost(metadata.cost, provider.costMultiplier)
      : undefined

  return {
    name: provider.useCatalogName ? metadata.name : undefined,
    reasoning: capability(metadata.reasoning, reasoning => snapshot.reasoning || reasoning),
    input: capability(metadata.input, input => unionInput(snapshot.input, input)),
    contextWindow: limit(metadata.contextWindow, snapshot.contextWindow),
    maxTokens: limit(metadata.maxTokens, snapshot.maxTokens),
    cost: provider.costPolicy === 'zero' ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : catalogCost,
    // pi.dev ships a real level map, while one derived from models.dev guesses at provider strings.
    thinkingLevelMap:
      (entry.source === 'pi.dev' || provider.mapThinkingLevels ? metadata.thinkingLevelMap : undefined) ??
      donor?.metadata.thinkingLevelMap,
    // `compat` is keyed on `api`, so copying it across APIs is wrong even for the same model.
    compat:
      (entry.api === snapshot.api ? metadata.compat : undefined) ??
      (donor?.api === snapshot.api ? donor.metadata.compat : undefined),
  }
}

function applyLayer(draft: Draft, label: string, layer: MetadataOverride, provenance: Map<string, string>): void {
  for (const field of OVERRIDE_FIELDS) {
    if (layer[field] !== undefined) {
      provenance.set(field, label)
    }
  }
  draft.name = layer.name ?? draft.name
  draft.reasoning = layer.reasoning ?? draft.reasoning
  draft.input = layer.input ?? draft.input
  draft.cost = layer.cost === undefined ? draft.cost : mergeCost(draft.cost, layer.cost)
  draft.contextWindow = layer.contextWindow ?? draft.contextWindow
  draft.maxTokens = layer.maxTokens ?? draft.maxTokens
  draft.thinkingLevelMap =
    layer.thinkingLevelMap === undefined
      ? draft.thinkingLevelMap
      : { ...draft.thinkingLevelMap, ...layer.thinkingLevelMap }
  draft.compat = layer.compat ?? draft.compat
}

export function mergeMetadata({ snapshot, provider, resolution, userAuthored }: MergeInput): MergeOutput {
  const provenance = new Map<string, string>(OVERRIDE_FIELDS.map(field => [field, 'existing']))
  const draft: Draft = {
    name: snapshot.name,
    reasoning: snapshot.reasoning,
    input: [...snapshot.input],
    cost: snapshot.cost,
    contextWindow: snapshot.contextWindow,
    maxTokens: snapshot.maxTokens,
    thinkingLevelMap: snapshot.thinkingLevelMap,
    compat: snapshot.compat,
  }

  if (resolution.kind === 'resolved') {
    const layer = catalogLayer(resolution, provider, snapshot)
    // An automatic value never overwrites a hand-written one; an explicit override, being as deliberate, may.
    for (const field of userAuthored ?? []) {
      if (isOverrideField(field)) {
        delete layer[field]
        provenance.set(field, 'models.json')
      }
    }
    applyLayer(draft, resolution.entry.source, layer, provenance)
    for (const rule of [resolution.prefixRule, resolution.suffixRule]) {
      if (rule?.override !== undefined) {
        applyLayer(draft, `rule '${rule.id}'`, rule.override, provenance)
      }
    }
  }
  const override = provider.models.get(snapshot.id)?.override
  if (override !== undefined) {
    applyLayer(draft, 'model override', override, provenance)
  }

  const model = compact<ChatModelConfig>({
    id: snapshot.id,
    name: draft.name,
    // Pinned rather than inherited: Pi falls back to `models[0]` and throws when it cannot resolve these,
    // which a later recompose turns into a deleted provider.
    api: snapshot.api,
    baseUrl: snapshot.baseUrl,
    reasoning: draft.reasoning,
    input: draft.input,
    cost: draft.cost,
    contextWindow: draft.contextWindow,
    maxTokens: Math.min(draft.maxTokens, draft.contextWindow),
    thinkingLevelMap:
      draft.thinkingLevelMap === undefined ? undefined : compact<ThinkingLevelMap>(draft.thinkingLevelMap),
    compat: draft.compat,
    headers: snapshot.headers,
    samplingParams: snapshot.samplingParams,
    samplingParamsByThinkingLevel: snapshot.samplingParamsByThinkingLevel,
    promptCache: snapshot.promptCache,
    inputLimits: snapshot.inputLimits,
  })

  return { model, provenance }
}
