import type { IdentityResolver, ModelIdentity } from './identity.js'
import type { TurnObservation } from './observe.js'
import { compareVersions } from './identity.js'

export type FindingLevel = 'ok' | 'info' | 'warn' | 'critical'

/** Which way the substitution went. `lateral` means different, with no ordering between them. */
export type Direction = 'lower' | 'higher' | 'lateral'

export interface Finding {
  level: FindingLevel
  code: string
  direction?: Direction | undefined
  /** Short fragment shown after the slugs, set only where the two slugs cannot say it. */
  note?: string | undefined
}

type Outcome = 'match' | 'substituted' | 'unverified'

export interface Verdict {
  turn: TurnObservation
  findings: Finding[]
  level: FindingLevel
  outcome: Outcome
  direction: Direction | undefined
}

const LEVEL_RANK: Record<FindingLevel, number> = { ok: 0, info: 0, warn: 1, critical: 2 }

/** Ordered weakest to strongest, for both Pi levels and provider-native efforts. */
const EFFORT_RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Codes that mean the server answered as a model you did not select. */
const SUBSTITUTION_CODES = new Set([
  'MODEL_SUBSTITUTED',
  'MODEL_MISMATCH',
  'MODEL_VARIANT',
  'MODEL_UNRECOGNIZED',
  'VENDOR_MISMATCH',
])

function directionFor(difference: number): Direction {
  return difference < 0 ? 'lower' : 'higher'
}

function levelFor(direction: Direction): FindingLevel {
  // An upgrade is still not what you selected — it changes cost and behaviour — but being handed
  // something cheaper is the failure worth stopping for.
  return direction === 'higher' ? 'warn' : 'critical'
}

function substitution(direction: Direction): Finding {
  return { level: levelFor(direction), code: 'MODEL_SUBSTITUTED', direction }
}

function judgeModel(
  requested: string,
  served: string | undefined,
  requestedId: ModelIdentity | undefined,
  servedId: ModelIdentity | undefined,
): Finding {
  if (served === undefined) {
    return { level: 'warn', code: 'UNVERIFIED' }
  }

  const requestedKey = requested.trim().toLowerCase()
  const servedKey = served.trim().toLowerCase()
  if (requestedKey === servedKey) {
    return { level: 'ok', code: 'MODEL_MATCH' }
  }

  const sharedBase = requestedId?.base !== undefined && requestedId.base === servedId?.base
  if (sharedBase || servedKey.startsWith(`${requestedKey}-`) || requestedKey.startsWith(`${servedKey}-`)) {
    return { level: 'warn', code: 'MODEL_VARIANT', direction: 'lateral', note: 'variant suffix' }
  }

  if (servedId !== undefined && !servedId.known && servedId.version.length === 0 && servedId.variant === undefined) {
    return { level: 'critical', code: 'MODEL_UNRECOGNIZED', direction: 'lateral' }
  }

  if (requestedId !== undefined && servedId !== undefined && requestedId.vendor !== servedId.vendor) {
    return { level: 'critical', code: 'VENDOR_MISMATCH', direction: 'lateral' }
  }

  const requestedTier = requestedId?.tier
  const servedTier = servedId?.tier
  if (requestedTier !== undefined && servedTier !== undefined && requestedTier !== servedTier) {
    return substitution(directionFor(servedTier - requestedTier))
  }

  const sameFamily =
    requestedId?.family !== undefined && servedId?.family !== undefined && requestedId.family === servedId.family
  if (sameFamily && requestedId.classRank !== undefined && servedId.classRank !== undefined) {
    const difference = servedId.classRank - requestedId.classRank
    if (difference !== 0) {
      return substitution(directionFor(difference))
    }
  }

  if (sameFamily && requestedId.version.length > 0 && servedId.version.length > 0) {
    const difference = compareVersions(servedId.version, requestedId.version)
    if (difference !== 0) {
      return substitution(directionFor(difference))
    }
  }

  if (sameFamily && servedId.sizeMarker !== undefined && requestedId.sizeMarker === undefined) {
    return { ...substitution('lower'), note: `'${servedId.sizeMarker}' sibling` }
  }

  if (sameFamily && requestedId.sizeMarker !== undefined && servedId.largeMarker !== undefined) {
    return { ...substitution('higher'), note: `'${servedId.largeMarker}' sibling` }
  }

  return { level: 'critical', code: 'MODEL_MISMATCH', direction: 'lateral' }
}

function judgeEffort(turn: TurnObservation): Finding | undefined {
  const { selectedEffort, expectedEffort, sentEffort } = turn
  if (selectedEffort === undefined || expectedEffort === undefined || sentEffort === undefined) {
    return undefined
  }
  if (expectedEffort.toLowerCase() === sentEffort.toLowerCase()) {
    return undefined
  }

  const from = EFFORT_RANK.indexOf(expectedEffort.toLowerCase())
  const to = EFFORT_RANK.indexOf(sentEffort.toLowerCase())
  const direction: Direction = from < 0 || to < 0 ? 'lateral' : directionFor(to - from)

  return { level: 'warn', code: 'EFFORT_SUBSTITUTED', direction, note: `${expectedEffort}→${sentEffort}` }
}

function judgeSafetyBuffering(turn: TurnObservation): Finding | undefined {
  const faster = turn.fasterFallbackModel
  if (faster === undefined) {
    return undefined
  }
  const served = turn.servedModel?.trim().toLowerCase()
  // Naming your own model as the fallback and then serving it substitutes nothing, so the
  // fallback only counts as fired when it displaced the model you asked for.
  if (served === faster.trim().toLowerCase() && served !== turn.requestedModel.trim().toLowerCase()) {
    return { level: 'critical', code: 'SAFETY_BUFFERING_APPLIED', direction: 'lower', note: 'safety buffering' }
  }

  // `x-codex-safety-buffering-enabled: false` does not disable the fallback, so only the presence
  // of a faster model is consulted. Upstream pins that in a test named
  // `buffering_enabled_header_does_not_gate_the_faster_model_fallback`.
  return { level: 'warn', code: 'SAFETY_BUFFERING_ARMED', note: `fallback armed: ${faster}` }
}

export function judgeTurn(turn: TurnObservation, resolver: IdentityResolver): Verdict {
  const requestedId = resolver.identify(turn.requestedModel)
  const servedId = resolver.identify(turn.servedModel)
  const model = judgeModel(turn.requestedModel, turn.servedModel, requestedId, servedId)
  const findings: Finding[] = [model]

  const buffering = judgeSafetyBuffering(turn)
  if (buffering !== undefined) {
    findings.push(buffering)
  }

  if (requestedId?.vendor === 'openai' && turn.backendFamily === 'anthropic-messages') {
    findings.push({
      level: 'critical',
      code: 'BACKEND_FAMILY_MISMATCH',
      direction: 'lateral',
      note: 'Anthropic-shaped response id',
    })
  }

  const effort = judgeEffort(turn)
  if (effort !== undefined) {
    findings.push(effort)
  }

  if (requestedId !== undefined && !requestedId.known) {
    findings.push({ level: 'info', code: 'REQUESTED_MODEL_UNRECORDED' })
  }
  if (model.code === 'MODEL_MATCH' && servedId !== undefined && !servedId.known) {
    findings.push({ level: 'info', code: 'MODEL_UNRECORDED' })
  }

  const level = findings.reduce<FindingLevel>(
    (worst, finding) => (LEVEL_RANK[finding.level] > LEVEL_RANK[worst] ? finding.level : worst),
    'ok',
  )
  const outcome: Outcome =
    model.code === 'UNVERIFIED' ? 'unverified' : SUBSTITUTION_CODES.has(model.code) ? 'substituted' : 'match'

  return { turn, findings, level, outcome, direction: model.direction }
}

export function isSubstitution(verdict: Verdict): boolean {
  return (
    verdict.outcome === 'substituted' || verdict.findings.some(finding => finding.code === 'SAFETY_BUFFERING_APPLIED')
  )
}
