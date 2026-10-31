import type { IdentifyModel, ModelIdentity } from './identity.js'
import type { TurnObservation } from './observe.js'
import { compareVersions } from './identity.js'

export type FindingLevel = 'ok' | 'info' | 'warn' | 'critical'

/** `lateral` means a different model, with nothing to order the two. */
export type Direction = 'lower' | 'higher' | 'lateral'

export interface Finding {
  level: FindingLevel
  code: string
  direction?: Direction | undefined
  /** Shown after the slugs, only where the two slugs cannot say it. */
  note?: string | undefined
}

export interface Verdict {
  turn: TurnObservation
  findings: Finding[]
  level: FindingLevel
  outcome: 'match' | 'substituted' | 'unverified'
  direction: Direction | undefined
}

const LEVEL_RANK: Record<FindingLevel, number> = { ok: 0, info: 0, warn: 1, critical: 2 }

function substitution(difference: number, note?: string): Finding {
  // An upgrade still is not what you selected, but being handed something cheaper is the failure worth stopping for.
  return difference < 0
    ? { level: 'critical', code: 'MODEL_SUBSTITUTED', direction: 'lower', note }
    : { level: 'warn', code: 'MODEL_SUBSTITUTED', direction: 'higher', note }
}

function judgeModel(requested: ModelIdentity, served: ModelIdentity | undefined): Finding {
  if (served === undefined) {
    return { level: 'warn', code: 'UNVERIFIED' }
  }
  if (requested.key === served.key) {
    return { level: 'ok', code: 'MODEL_MATCH' }
  }
  if (
    (requested.base !== undefined && requested.base === served.base) ||
    served.key.startsWith(`${requested.key}-`) ||
    requested.key.startsWith(`${served.key}-`)
  ) {
    return { level: 'warn', code: 'MODEL_VARIANT', direction: 'lateral', note: 'variant suffix' }
  }
  if (!served.known && served.version.length === 0 && served.variant === undefined) {
    return { level: 'critical', code: 'MODEL_UNRECOGNIZED', direction: 'lateral' }
  }
  if (requested.vendor !== served.vendor) {
    return { level: 'critical', code: 'VENDOR_MISMATCH', direction: 'lateral' }
  }
  if (requested.tier !== undefined && served.tier !== undefined && requested.tier !== served.tier) {
    return substitution(served.tier - requested.tier)
  }

  if (requested.family !== undefined && requested.family === served.family) {
    if (
      requested.classRank !== undefined &&
      served.classRank !== undefined &&
      requested.classRank !== served.classRank
    ) {
      return substitution(served.classRank - requested.classRank)
    }
    const versions = compareVersions(served.version, requested.version)
    if (requested.version.length > 0 && served.version.length > 0 && versions !== 0) {
      return substitution(versions)
    }
    if (served.sizeMarker !== undefined && requested.sizeMarker === undefined) {
      return substitution(-1, `'${served.sizeMarker}' sibling`)
    }
    if (requested.sizeMarker !== undefined && served.largeMarker !== undefined) {
      return substitution(1, `'${served.largeMarker}' sibling`)
    }
  }

  return { level: 'critical', code: 'MODEL_MISMATCH', direction: 'lateral' }
}

function judgeEffort({ selectedEffort, expectedEffort, sentEffort }: TurnObservation): Finding | undefined {
  if (
    selectedEffort === undefined ||
    expectedEffort === undefined ||
    sentEffort === undefined ||
    expectedEffort.toLowerCase() === sentEffort.toLowerCase()
  ) {
    return undefined
  }

  return { level: 'warn', code: 'EFFORT_SUBSTITUTED', note: `${expectedEffort}→${sentEffort}` }
}

function judgeSafetyBuffering({
  fasterFallbackModel,
  servedModel,
  requestedModel,
}: TurnObservation): Finding | undefined {
  if (fasterFallbackModel === undefined) {
    return undefined
  }
  const served = servedModel?.trim().toLowerCase()
  // A fallback naming your own model substitutes nothing, so it only counts as fired when it displaced that model.
  if (served === fasterFallbackModel.trim().toLowerCase() && served !== requestedModel.trim().toLowerCase()) {
    return { level: 'critical', code: 'SAFETY_BUFFERING_APPLIED', note: 'safety buffering' }
  }

  // `x-codex-safety-buffering-enabled: false` does not disable the fallback upstream, so only the faster model counts.
  return { level: 'warn', code: 'SAFETY_BUFFERING_ARMED', note: `fallback armed: ${fasterFallbackModel}` }
}

export function judgeTurn(turn: TurnObservation, identify: IdentifyModel): Verdict {
  const requested = identify(turn.requestedModel)
  const served = turn.servedModel === undefined ? undefined : identify(turn.servedModel)
  const model = judgeModel(requested, served)
  const findings = [model, judgeSafetyBuffering(turn)]

  // Anthropic message ids start with `msg_01`; a relay that swaps the upstream rarely rewrites the id.
  if (requested.vendor === 'openai' && turn.responseId?.trim().startsWith('msg_01')) {
    findings.push({ level: 'critical', code: 'BACKEND_FAMILY_MISMATCH', note: 'Anthropic-shaped response id' })
  }
  findings.push(judgeEffort(turn))
  if (!requested.known) {
    findings.push({ level: 'info', code: 'REQUESTED_MODEL_UNRECORDED' })
  }
  if (model.code === 'MODEL_MATCH' && served?.known === false) {
    findings.push({ level: 'info', code: 'MODEL_UNRECORDED' })
  }

  const present = findings.filter(finding => finding !== undefined)

  return {
    turn,
    findings: present,
    level: present.reduce<FindingLevel>(
      (worst, finding) => (LEVEL_RANK[finding.level] > LEVEL_RANK[worst] ? finding.level : worst),
      'ok',
    ),
    outcome: model.code === 'UNVERIFIED' ? 'unverified' : model.code === 'MODEL_MATCH' ? 'match' : 'substituted',
    direction: model.direction,
  }
}

export function isSubstitution(verdict: Verdict): boolean {
  return (
    verdict.outcome === 'substituted' || verdict.findings.some(finding => finding.code === 'SAFETY_BUFFERING_APPLIED')
  )
}
