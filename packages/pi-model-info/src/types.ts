import type { Api } from '@earendil-works/pi-ai'
import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent'

/** Pi exports only the union, and chat is the one kind this extension completes. */
export type ChatModelConfig = Extract<ProviderModelConfig, { type?: 'chat' }>

export type ModelCost = ChatModelConfig['cost']
export type ModelCostTier = NonNullable<ModelCost['tiers']>[number]
export type ModelInput = ChatModelConfig['input']
export type ModelCompat = ChatModelConfig['compat']
export type ThinkingLevelMap = NonNullable<ChatModelConfig['thinkingLevelMap']>

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/** A parsed config's shape, whose optional slots admit `undefined` where Pi's own map does not. */
export type ThinkingLevelMapInput = { [K in ThinkingLevel]?: string | null | undefined }

/** The subset of `Model<Api>` this extension reads; registry models are assignable to it. */
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
  promptCache?: ChatModelConfig['promptCache'] | undefined
  inputLimits?: ChatModelConfig['inputLimits'] | undefined
}

/** Spelled out because `Partial<ModelCost>` drops the `| undefined` a parsed config needs. */
interface PartialModelCost {
  input?: number | undefined
  output?: number | undefined
  cacheRead?: number | undefined
  cacheWrite?: number | undefined
  tiers?: ModelCostTier[] | undefined
}

/** Every field a rule, gate, or catalog entry may contribute, never an identity field. */
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

export type SourceId = 'pi.dev' | 'models.dev'

export interface AffixRule {
  /** Referenced by per-model gating. */
  id: string
  kind: 'prefix' | 'suffix'
  /** The literal affix, separator included: `-free`, `:free`. */
  value: string
  enabled?: boolean | undefined
  /** Applied only when this rule was actually used for the match. */
  override?: MetadataOverride | undefined
}

export interface ModelGate {
  /** Unset means every rule, `[]` none, `['id']` only those. */
  prefixes?: string[] | undefined
  suffixes?: string[] | undefined
  /** `provider/model` or a bare id, tried before anything else. */
  alias?: string | undefined
  override?: MetadataOverride | undefined
  skip?: boolean | undefined
}

export interface ResolvedProvider {
  id: string
  catalogProvider: string | undefined
  costMultiplier: number
  costPolicy: 'catalog' | 'zero' | 'keep'
  contextWindowPolicy: 'catalog' | 'min' | 'keep'
  capabilityPolicy: 'catalog' | 'widen' | 'keep'
  useCatalogName: boolean
  mapThinkingLevels: boolean
  allowDynamic: boolean
  models: Map<string, ModelGate>
}

/** The config with its sugar folded in, defaults materialised, and rules ordered. */
export interface ResolvedConfig {
  providers: Map<string, ResolvedProvider>
  /** Longest `value` first, then config order, built-ins last. */
  prefixRules: AffixRule[]
  suffixRules: AffixRule[]
  /** In priority order. */
  sources: SourceId[]
  network: { enabled: boolean; timeoutMs: number; maxBytes: number }
  cache: { ttlMs: number; dir: string | undefined }
  applyOnIdleOnly: boolean
}

export interface CatalogEntry {
  source: SourceId
  /** Provider id within the source catalog, when the source is provider-scoped. */
  sourceProvider: string | undefined
  /** The id verbatim as the source spells it. */
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

/** Every bucket is in source-priority order. */
export interface CatalogIndex {
  /** Provider + NUL + lowercased id. */
  scoped: Map<string, CatalogEntry[]>
  /** Lowercased verbatim id. */
  exact: Map<string, CatalogEntry[]>
  /** Lowercased vendor-stripped id. */
  bare: Map<string, CatalogEntry[]>
  /** Lowercased bare id → vendor, the last tie-break. */
  vendors: Map<string, string>
}

export type MatchKind = 'alias' | 'exact' | 'vendor-qualified' | 'stripped'

export interface ResolvedMatch {
  kind: 'resolved'
  entry: CatalogEntry
  /** Same-provider entry from another source, for structural backfill only. */
  donor: CatalogEntry | undefined
  matchKind: MatchKind
  prefixRule: AffixRule | undefined
  suffixRule: AffixRule | undefined
}

export type Resolution =
  | ResolvedMatch
  | { kind: 'ambiguous'; candidates: CatalogEntry[] }
  | { kind: 'unresolved'; reason: 'no-match' | 'alias-miss' | 'rules-disabled' | 'skipped' }
