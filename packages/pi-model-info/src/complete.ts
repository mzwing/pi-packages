import type { CatalogSnapshot } from './catalog.js'
import type { EnrichedModel } from './merge.js'
import type { Resolution, ResolvedConfig, ResolvedProvider, SnapshotModel } from './types.js'
import { mergeMetadata } from './merge.js'
import { resolveModel } from './resolver.js'

export interface ModelReport {
  id: string
  resolution: Resolution
  provenance: Map<string, string>
  issues: string[]
  model: EnrichedModel
}

/**
 * Everything one completion needs. Passed per call rather than captured, so a provider that
 * completes lazily reads the catalog in force at that moment instead of the one it was built with.
 */
export interface CompletionContext {
  config: ResolvedConfig
  provider: ResolvedProvider
  catalog: CatalogSnapshot
  /** Field names the user hand-wrote in models.json `models[]`, by model id. */
  authored: Map<string, Set<string>> | undefined
}

export interface Completion {
  model: EnrichedModel
  report: ModelReport
}

/** The single completion pass, shared by every strategy so they cannot drift apart. */
export function completeModel(snapshot: SnapshotModel, context: CompletionContext): Completion {
  const resolution = resolveModel({
    index: context.catalog.index,
    provider: context.provider,
    prefixRules: context.config.prefixRules,
    suffixRules: context.config.suffixRules,
    modelId: snapshot.id,
  })
  const merged = mergeMetadata({
    snapshot,
    provider: context.provider,
    resolution,
    gate: context.provider.models.get(snapshot.id),
    userAuthored: context.authored?.get(snapshot.id),
  })

  return {
    model: merged.model,
    report: { id: snapshot.id, resolution, provenance: merged.provenance, issues: merged.issues, model: merged.model },
  }
}
