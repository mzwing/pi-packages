import type { IdentityResolver, ModelIdentity } from './identity.js'
import type { TurnObservation } from './observe.js'
import { compareVersions, describeIdentity } from './identity.js'

export type FindingLevel = 'ok' | 'info' | 'warn' | 'critical'

/** Which way the substitution went. `lateral` means different, with no ordering between them. */
export type Direction = 'lower' | 'higher' | 'lateral'

interface Finding {
  level: FindingLevel
  code: string
  message: string
  direction?: Direction | undefined
}

type Outcome = 'match' | 'substituted' | 'unverified'

export interface Verdict {
  turn: TurnObservation
  findings: Finding[]
  level: FindingLevel
  outcome: Outcome
  direction: Direction | undefined
  effort: Finding | undefined
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

function substitution(requested: string, served: string, direction: Direction, why: string): Finding {
  return {
    level: levelFor(direction),
    code: 'MODEL_SUBSTITUTED',
    message: `Requested '${requested}' but the server served '${served}'. ${why}`,
    direction,
  }
}

function judgeModel(
  requested: string,
  served: string | undefined,
  requestedId: ModelIdentity | undefined,
  servedId: ModelIdentity | undefined,
  sawRoutingHeaders: boolean,
): Finding {
  if (served === undefined) {
    return {
      level: 'warn',
      code: 'UNVERIFIED',
      message: sawRoutingHeaders
        ? `The response carried routing headers but named no model, so '${requested}' could not be confirmed.`
        : `No 'openai-model' header and no response model, so nothing states which model served this turn. That is missing evidence, not a clean result.`,
    }
  }

  const requestedKey = requested.trim().toLowerCase()
  const servedKey = served.trim().toLowerCase()
  if (requestedKey === servedKey) {
    return {
      level: 'ok',
      code: 'MODEL_MATCH',
      message: `Server reported '${served}', which matches the requested model.`,
    }
  }

  const sharedBase = requestedId?.base !== undefined && requestedId.base === servedId?.base
  if (sharedBase || servedKey.startsWith(`${requestedKey}-`) || requestedKey.startsWith(`${servedKey}-`)) {
    return {
      level: 'warn',
      code: 'MODEL_VARIANT',
      message: `Server reported '${served}' while you requested '${requested}': the same base model with a server-side variant suffix.`,
      direction: 'lateral',
    }
  }

  if (servedId !== undefined && !servedId.known && servedId.version.length === 0 && servedId.variant === undefined) {
    return {
      level: 'critical',
      code: 'MODEL_UNRECOGNIZED',
      message: `Requested '${requested}' but the server served '${served}', a slug that is ranked nowhere, offered by nothing, and does not parse as a model name.`,
      direction: 'lateral',
    }
  }

  if (requestedId !== undefined && servedId !== undefined && requestedId.vendor !== servedId.vendor) {
    return {
      level: 'critical',
      code: 'VENDOR_MISMATCH',
      message: `Requested '${requested}' but the server served '${served}'. One is an OpenAI model and the other is not, so this is a substitution, not a tier change.`,
      direction: 'lateral',
    }
  }

  const requestedTier = requestedId?.tier
  const servedTier = servedId?.tier
  if (requestedTier !== undefined && servedTier !== undefined && requestedTier !== servedTier) {
    const direction = directionFor(servedTier - requestedTier)

    return substitution(requested, served, direction, `It ranks ${servedTier} against ${requestedTier}.`)
  }

  const sameFamily =
    requestedId?.family !== undefined && servedId?.family !== undefined && requestedId.family === servedId.family
  if (sameFamily && requestedId.version.length > 0 && servedId.version.length > 0) {
    const difference = compareVersions(servedId.version, requestedId.version)
    if (difference !== 0) {
      const direction = directionFor(difference)

      return substitution(
        requested,
        served,
        direction,
        `Neither slug is ranked here, but they belong to the same family and the served generation is ${direction === 'lower' ? 'older' : 'newer'} (v${servedId.version.join('.')} against v${requestedId.version.join('.')}).`,
      )
    }
  }

  if (sameFamily && servedId.sizeMarker !== undefined && requestedId.sizeMarker === undefined) {
    return substitution(
      requested,
      served,
      'lower',
      `'${servedId.sizeMarker}' marks the smaller, cheaper sibling in this family.`,
    )
  }

  if (sameFamily && requestedId.sizeMarker !== undefined && servedId.largeMarker !== undefined) {
    return substitution(requested, served, 'higher', `It carries the larger-sibling marker '${servedId.largeMarker}'.`)
  }

  return {
    level: 'critical',
    code: 'MODEL_MISMATCH',
    message: `Requested '${requested}' but the server served '${served}'. Direction unknown (${requestedId === undefined ? 'unknown' : describeIdentity(requestedId)} against ${servedId === undefined ? 'unknown' : describeIdentity(servedId)}); rank both slugs under \`tiers\` for a direction.`,
    direction: 'lateral',
  }
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

  return {
    level: 'warn',
    code: 'EFFORT_SUBSTITUTED',
    message: `You selected thinking level '${selectedEffort}', which this model maps to effort '${expectedEffort}', but '${sentEffort}' went on the wire. This is what Pi sent, not what the server used — nothing on the response side confirms effort.`,
    direction,
  }
}

function judgeSafetyBuffering(turn: TurnObservation): Finding | undefined {
  const faster = turn.fasterFallbackModel
  if (faster === undefined) {
    return undefined
  }
  const enabled = turn.bufferingEnabled ?? '(absent)'
  const served = turn.servedModel?.trim().toLowerCase()
  // Naming your own model as the fallback and then serving it substitutes nothing, so the
  // fallback only counts as fired when it displaced the model you asked for.
  if (served === faster.trim().toLowerCase() && served !== turn.requestedModel.trim().toLowerCase()) {
    return {
      level: 'critical',
      code: 'SAFETY_BUFFERING_APPLIED',
      message: `The server named '${faster}' as its faster fallback and that is what served this turn.`,
      direction: 'lower',
    }
  }

  return {
    level: 'warn',
    code: 'SAFETY_BUFFERING_ARMED',
    message: `Safety buffering is armed: the server named '${faster}' as the faster fallback model (enabled = ${enabled}). enabled=false does not disable it.`,
  }
}

export function judgeTurn(turn: TurnObservation, resolver: IdentityResolver): Verdict {
  const requestedId = resolver.identify(turn.requestedModel)
  const servedId = resolver.identify(turn.servedModel)
  const model = judgeModel(turn.requestedModel, turn.servedModel, requestedId, servedId, turn.sawRoutingHeaders)
  const findings: Finding[] = [model]

  const buffering = judgeSafetyBuffering(turn)
  if (buffering !== undefined) {
    findings.push(buffering)
  }

  if (requestedId?.vendor === 'openai' && turn.backendFamily === 'anthropic-messages') {
    findings.push({
      level: 'critical',
      code: 'BACKEND_FAMILY_MISMATCH',
      message: `Requested the OpenAI model '${turn.requestedModel}' but the response id is Anthropic-shaped ('${turn.responseId}'), so this turn was not served by OpenAI.`,
      direction: 'lateral',
    })
  }

  const effort = judgeEffort(turn)
  if (effort !== undefined) {
    findings.push(effort)
  }

  if (requestedId !== undefined && !requestedId.known) {
    findings.push({
      level: 'info',
      code: 'REQUESTED_MODEL_UNRECORDED',
      message: `Requested model '${turn.requestedModel}' is ranked nowhere local (${describeIdentity(requestedId)}), so the comparison leans on slug structure. Rank it under \`tiers\` for an exact verdict.`,
    })
  }
  if (model.code === 'MODEL_MATCH' && servedId !== undefined && !servedId.known) {
    findings.push({
      level: 'info',
      code: 'MODEL_UNRECORDED',
      message: `That slug is recorded nowhere local, so the name matches but nothing corroborates what it denotes.`,
    })
  }

  const level = findings.reduce<FindingLevel>(
    (worst, finding) => (LEVEL_RANK[finding.level] > LEVEL_RANK[worst] ? finding.level : worst),
    'ok',
  )
  const outcome: Outcome =
    model.code === 'UNVERIFIED' ? 'unverified' : SUBSTITUTION_CODES.has(model.code) ? 'substituted' : 'match'

  return { turn, findings, level, outcome, direction: model.direction, effort }
}

export function isSubstitution(verdict: Verdict): boolean {
  return (
    verdict.outcome === 'substituted' || verdict.findings.some(finding => finding.code === 'SAFETY_BUFFERING_APPLIED')
  )
}
