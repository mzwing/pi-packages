import type {
  MetadataOverride,
  ModelCost,
  ModelGate,
  ModelInput,
  Resolution,
  ResolvedMatch,
  ResolvedProvider,
  SnapshotModel,
  ThinkingLevelMap,
  ThinkingLevelMapInput,
} from './types.js'
import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'
import { compact } from './compact.js'
import { THINKING_LEVELS } from './types.js'

/**
 * `ProviderModelConfig` omits `samplingParams`, but the runtime shape has it and `applyExtension`
 * spreads the definition verbatim — carrying it here is what keeps a user's sampling defaults alive.
 */
export interface EnrichedModel extends ProviderModelConfig {
  samplingParams?: Record<string, unknown> | undefined
}

export interface MergeInput {
  snapshot: SnapshotModel
  provider: ResolvedProvider
  resolution: Resolution
  gate: ModelGate | undefined
  /** Field names the user hand-wrote in models.json `models[]`; catalogs never overwrite them. */
  userAuthored?: ReadonlySet<string> | undefined
}

export interface MergeOutput {
  model: EnrichedModel
  issues: string[]
  /** Field name to the layer that produced its final value, for `/model-info`. */
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

function isOverrideField(field: string): field is OverrideField {
  return (OVERRIDE_FIELDS as readonly string[]).includes(field)
}

function mergeCost(base: ModelCost, incoming: NonNullable<MetadataOverride['cost']>): ModelCost {
  return compact<ModelCost>({
    input: incoming.input ?? base.input,
    output: incoming.output ?? base.output,
    cacheRead: incoming.cacheRead ?? base.cacheRead,
    cacheWrite: incoming.cacheWrite ?? base.cacheWrite,
    tiers: incoming.tiers ?? base.tiers,
  })
}

function unionInput(a: ModelInput, b: ModelInput): ModelInput {
  const combined = new Set<string>([...a, ...b])
  const input: ModelInput = ['text']
  if (combined.has('image')) {
    input.push('image')
  }

  return input
}

/** A relay's markup applies to catalog pricing only, never to a rule's explicit `0`. */
function scaleCost(
  cost: NonNullable<MetadataOverride['cost']>,
  multiplier: number,
): NonNullable<MetadataOverride['cost']> {
  if (multiplier === 1) {
    return cost
  }
  const scale = (value: number | undefined): number | undefined =>
    value === undefined ? undefined : value * multiplier

  return compact<NonNullable<MetadataOverride['cost']>>({
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
 * Cost, limits and capabilities all come from the single winning entry. Only fields the winner's
 * source schema cannot express are backfilled, and only from a same-provider pi.dev donor.
 */
function catalogLayer(match: ResolvedMatch, provider: ResolvedProvider, snapshot: SnapshotModel): MetadataOverride {
  const { entry, donor } = match
  const metadata = entry.metadata

  // pi.dev ships a real level map; the one derived from models.dev's `reasoning_options` guesses at
  // provider-specific strings, so it stays opt-in.
  const ownMap = entry.source === 'pi.dev' || provider.mapThinkingLevels ? metadata.thinkingLevelMap : undefined

  const layer: MetadataOverride = {}

  if (provider.useCatalogName && metadata.name !== undefined) {
    layer.name = metadata.name
  }

  if (provider.capabilityPolicy !== 'keep') {
    if (metadata.reasoning !== undefined) {
      layer.reasoning =
        provider.capabilityPolicy === 'widen' ? snapshot.reasoning || metadata.reasoning : metadata.reasoning
    }
    if (metadata.input !== undefined) {
      layer.input = provider.capabilityPolicy === 'widen' ? unionInput(snapshot.input, metadata.input) : metadata.input
    }
  }

  if (provider.contextWindowPolicy !== 'keep') {
    if (metadata.contextWindow !== undefined) {
      layer.contextWindow =
        provider.contextWindowPolicy === 'min'
          ? Math.min(metadata.contextWindow, snapshot.contextWindow)
          : metadata.contextWindow
    }
    if (metadata.maxTokens !== undefined) {
      layer.maxTokens =
        provider.contextWindowPolicy === 'min' ? Math.min(metadata.maxTokens, snapshot.maxTokens) : metadata.maxTokens
    }
  }

  if (provider.costPolicy === 'zero') {
    layer.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  } else if (provider.costPolicy === 'catalog' && metadata.cost !== undefined) {
    layer.cost = scaleCost(metadata.cost, provider.costMultiplier)
  }

  const thinkingLevelMap = ownMap ?? donor?.metadata.thinkingLevelMap
  if (thinkingLevelMap !== undefined) {
    layer.thinkingLevelMap = thinkingLevelMap
  }

  // `compat` is a conditional type keyed on `api`; copying it across APIs is structurally wrong even
  // when the model is the same.
  const compat =
    (entry.api === snapshot.api ? metadata.compat : undefined) ??
    (donor?.api === snapshot.api ? donor.metadata.compat : undefined)
  if (compat !== undefined) {
    layer.compat = compat
  }

  return layer
}

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

/** Drops slots that are present but undefined; omission already means "provider default". */
function compactThinkingLevelMap(map: ThinkingLevelMapInput | undefined): ThinkingLevelMap | undefined {
  if (map === undefined) {
    return undefined
  }
  const compacted: ThinkingLevelMap = {}
  let kept = false
  for (const level of THINKING_LEVELS) {
    const value = map[level]
    if (value !== undefined) {
      compacted[level] = value
      kept = true
    }
  }

  return kept ? compacted : undefined
}

function applyLayer(draft: Draft, label: string, override: MetadataOverride, provenance: Map<string, string>): void {
  for (const field of OVERRIDE_FIELDS) {
    if (override[field] !== undefined) {
      provenance.set(field, label)
    }
  }
  if (override.name !== undefined) {
    draft.name = override.name
  }
  if (override.reasoning !== undefined) {
    draft.reasoning = override.reasoning
  }
  if (override.input !== undefined) {
    draft.input = override.input
  }
  if (override.cost !== undefined) {
    draft.cost = mergeCost(draft.cost, override.cost)
  }
  if (override.contextWindow !== undefined) {
    draft.contextWindow = override.contextWindow
  }
  if (override.maxTokens !== undefined) {
    draft.maxTokens = override.maxTokens
  }
  if (override.thinkingLevelMap !== undefined) {
    draft.thinkingLevelMap = { ...draft.thinkingLevelMap, ...override.thinkingLevelMap }
  }
  if (override.compat !== undefined) {
    draft.compat = override.compat
  }
}

/**
 * Automatic values never overwrite what the user hand-wrote in models.json; an explicit override
 * layered later is a different matter, being equally deliberate.
 */
function dropAuthored(layer: MetadataOverride, authored: ReadonlySet<string>, provenance: Map<string, string>): void {
  for (const field of authored) {
    if (isOverrideField(field)) {
      delete layer[field]
      provenance.set(field, 'models.json')
    }
  }
}

function isPositiveInt(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

function costIsValid(cost: ModelCost): boolean {
  const values = [
    cost.input,
    cost.output,
    cost.cacheRead,
    cost.cacheWrite,
    ...(cost.tiers ?? []).flatMap(tier => [tier.input, tier.output, tier.cacheRead, tier.cacheWrite]),
  ]

  return values.every(value => Number.isFinite(value) && value >= 0)
}

export function mergeMetadata(input: MergeInput): MergeOutput {
  const { snapshot, provider, resolution, gate } = input
  const issues: string[] = []
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
    if (input.userAuthored !== undefined) {
      dropAuthored(layer, input.userAuthored, provenance)
    }
    applyLayer(draft, resolution.entry.source, layer, provenance)

    for (const rule of [resolution.prefixRule, resolution.suffixRule]) {
      if (rule?.override !== undefined) {
        applyLayer(draft, `rule '${rule.id}'`, rule.override, provenance)
      }
    }
  }

  if (gate?.override !== undefined) {
    applyLayer(draft, 'model override', gate.override, provenance)
  }

  if (!isPositiveInt(draft.contextWindow)) {
    issues.push(`invalid contextWindow ${draft.contextWindow}; kept ${snapshot.contextWindow}`)
    draft.contextWindow = snapshot.contextWindow
    provenance.set('contextWindow', 'existing')
  }
  if (!isPositiveInt(draft.maxTokens)) {
    issues.push(`invalid maxTokens ${draft.maxTokens}; kept ${snapshot.maxTokens}`)
    draft.maxTokens = snapshot.maxTokens
    provenance.set('maxTokens', 'existing')
  }
  if (draft.maxTokens > draft.contextWindow) {
    draft.maxTokens = draft.contextWindow
  }
  if (!costIsValid(draft.cost)) {
    issues.push('invalid cost; kept the existing rates')
    draft.cost = snapshot.cost
    provenance.set('cost', 'existing')
  }
  if (draft.input.length === 0) {
    draft.input = [...snapshot.input]
    provenance.set('input', 'existing')
  }

  const model = compact<EnrichedModel>({
    id: snapshot.id,
    name: draft.name,
    // Pinned rather than inherited: `applyExtension` falls back to `models[0]` and throws when it
    // cannot resolve these, which a later recompose turns into a deleted provider.
    api: snapshot.api,
    baseUrl: snapshot.baseUrl,
    reasoning: draft.reasoning,
    input: draft.input,
    cost: draft.cost,
    contextWindow: draft.contextWindow,
    maxTokens: draft.maxTokens,
    thinkingLevelMap: compactThinkingLevelMap(draft.thinkingLevelMap),
    compat: draft.compat,
    headers: snapshot.headers,
    samplingParams: snapshot.samplingParams,
  })

  return { model, issues, provenance }
}
