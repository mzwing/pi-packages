import type { Api } from '@earendil-works/pi-ai'
import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'

export type ModelCost = ProviderModelConfig['cost']
export type ModelCostTier = NonNullable<ModelCost['tiers']>[number]
export type ModelInput = ProviderModelConfig['input']
export type ModelCompat = ProviderModelConfig['compat']
export type ThinkingLevelMap = NonNullable<ProviderModelConfig['thinkingLevelMap']>

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/** JSON can carry a present-but-undefined slot, which Pi's own map forbids; those are dropped on the way out. */
export type ThinkingLevelMapInput = { [K in ThinkingLevel]?: string | null | undefined }

/** The subset of `Model<Api>` this extension reads. Registry models are assignable to it. */
export interface SnapshotModel {
  id: string
  name: string
  api: Api
  baseUrl: string
  reasoning: boolean
  thinkingLevelMap?: ThinkingLevelMap | undefined
  input: ModelInput
  cost: ModelCost
  contextWindow: number
  maxTokens: number
  samplingParams?: Record<string, unknown> | undefined
  headers?: Record<string, string> | undefined
  compat?: ModelCompat | undefined
}

/** Spelled out because `Partial<ModelCost>` drops the `| undefined` a parsed config needs. */
interface PartialModelCost {
  input?: number | undefined
  output?: number | undefined
  cacheRead?: number | undefined
  cacheWrite?: number | undefined
  tiers?: ModelCostTier[] | undefined
}

/** Every field a rule, gate, or catalog entry may contribute. Never includes identity fields. */
export interface MetadataOverride {
  name?: string | undefined
  reasoning?: boolean | undefined
  input?: ModelInput | undefined
  cost?: PartialModelCost | undefined
  contextWindow?: number | undefined
  maxTokens?: number | undefined
  thinkingLevelMap?: ThinkingLevelMapInput | undefined
  compat?: ModelCompat | undefined
}

// ── Config ────────────────────────────────────────────────────────────────────

type AffixKind = 'prefix' | 'suffix'
type CostPolicy = 'catalog' | 'zero' | 'keep'
type ContextWindowPolicy = 'catalog' | 'min' | 'keep'
type CapabilityPolicy = 'catalog' | 'widen' | 'keep'
export type SourceId = 'pi.dev' | 'models.dev'

export interface AffixRule {
  /** Stable key referenced by per-model gating. */
  id: string
  kind: AffixKind
  /** Literal affix, separator included: `-free`, `:free`. */
  value: string
  /** Default true. Set false to disable a built-in without removing it. */
  enabled?: boolean | undefined
  /** Applied ONLY when this rule was actually used for the match. */
  override?: MetadataOverride | undefined
}

export interface ModelGate {
  /** unset = all rules · `[]` = none · `['id']` = only those. */
  prefixes?: string[] | undefined
  suffixes?: string[] | undefined
  /** Highest-priority resolution. `provider/model` or a bare id. */
  alias?: string | undefined
  /** Highest-priority merge layer. */
  override?: MetadataOverride | undefined
  /** Leave this model's metadata untouched. */
  skip?: boolean | undefined
}

export interface ProviderOptIn {
  /** Catalog provider to scope lookups to, e.g. `openrouter`. Tie-break tier 1. */
  catalogProvider?: string | undefined
  /** Relay markup applied to catalog cost only, before rule overrides. */
  costMultiplier?: number | undefined
  costPolicy?: CostPolicy | undefined
  contextWindowPolicy?: ContextWindowPolicy | undefined
  capabilityPolicy?: CapabilityPolicy | undefined
  useCatalogName?: boolean | undefined
  mapThinkingLevels?: boolean | undefined
  /** Accept the model-list freeze on a provider whose base refreshes dynamically. */
  allowDynamic?: boolean | undefined
  models?: Record<string, ModelGate> | undefined
}

export interface ModelInfoConfig {
  $schema?: string | undefined
  /** Opt-in only. An empty map means the extension does nothing. */
  providers: Record<string, ProviderOptIn>
  /** Flat sugar for `providers[p].models[m].alias`. Key splits at the FIRST `/`. */
  aliases?: Record<string, string> | undefined
  /** Flat sugar for `providers[p].models[m]`. Key splits at the FIRST `/`. */
  models?: Record<string, ModelGate> | undefined
  rules?: AffixRule[] | undefined
  builtinRules?: boolean | undefined
  /** Order is priority. */
  sources?: SourceId[] | undefined
  network?: { enabled?: boolean | undefined; timeoutMs?: number | undefined; maxBytes?: number | undefined } | undefined
  cache?: { ttlMs?: number | undefined; dir?: string | undefined } | undefined
  applyOnIdleOnly?: boolean | undefined
}

/** Config with sugar desugared, defaults materialised, and rules ordered. */
export interface ResolvedProvider {
  id: string
  catalogProvider: string | undefined
  costMultiplier: number
  costPolicy: CostPolicy
  contextWindowPolicy: ContextWindowPolicy
  capabilityPolicy: CapabilityPolicy
  useCatalogName: boolean
  mapThinkingLevels: boolean
  allowDynamic: boolean
  models: Map<string, ModelGate>
}

export interface ResolvedConfig {
  providers: Map<string, ResolvedProvider>
  /** Both sorted longest-`value`-first, then config order, built-ins last. */
  prefixRules: AffixRule[]
  suffixRules: AffixRule[]
  sources: SourceId[]
  network: { enabled: boolean; timeoutMs: number; maxBytes: number }
  cache: { ttlMs: number; dir: string | undefined }
  applyOnIdleOnly: boolean
}

// ── Catalog ───────────────────────────────────────────────────────────────────

export interface CatalogEntry {
  source: SourceId
  /** Provider id within the source catalog, when the source is provider-scoped. */
  sourceProvider: string | undefined
  /** The id verbatim as it appears in the source. */
  sourceId: string
  /** `vendor/model` identity when the source exposes one. */
  canonicalId: string
  api?: Api | undefined
  metadata: MetadataOverride
}

export interface NormalizedSource {
  source: SourceId
  entries: CatalogEntry[]
  /** Bare id → vendor, from `vendor/model` keys. Only models.dev populates this. */
  vendors: Map<string, string>
}

export interface CatalogIndex {
  /** Provider + NUL + lowercased id, to entries in source-priority order. */
  scoped: Map<string, CatalogEntry[]>
  /** Lowercased verbatim id → entries. */
  exact: Map<string, CatalogEntry[]>
  /** Lowercased vendor-stripped id → entries. */
  bare: Map<string, CatalogEntry[]>
  /** Lowercased bare id → vendor, for tie-break tier 4. */
  vendors: Map<string, string>
}

export type MatchKind = 'alias' | 'exact' | 'vendor-qualified' | 'stripped'
type UnresolvedReason = 'no-match' | 'alias-miss' | 'rules-disabled' | 'skipped'

export interface ResolvedMatch {
  kind: 'resolved'
  entry: CatalogEntry
  /** Same-provider entry from a higher-ranked source, for structural backfill only. */
  donor: CatalogEntry | undefined
  matchKind: MatchKind
  prefixRule: AffixRule | undefined
  suffixRule: AffixRule | undefined
}

export type Resolution =
  | ResolvedMatch
  | { kind: 'ambiguous'; candidates: CatalogEntry[] }
  | { kind: 'unresolved'; reason: UnresolvedReason }
