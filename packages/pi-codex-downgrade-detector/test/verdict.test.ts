import type { TurnObservation } from '../src/observe.js'
import type { Verdict } from '../src/verdict.js'
import { describe, expect, it } from 'vitest'
import { createIdentityResolver } from '../src/identity.js'
import { isSubstitution, judgeTurn } from '../src/verdict.js'

function turn(overrides: Partial<TurnObservation> = {}): TurnObservation {
  return {
    provider: 'openai-codex',
    requestedModel: 'gpt-6-astra',
    responseModel: undefined,
    responseId: undefined,
    servedModel: undefined,
    servedModelSource: undefined,
    fasterFallbackModel: undefined,
    bufferingEnabled: undefined,
    sawRoutingHeaders: false,
    backendFamily: 'unknown',
    status: 200,
    selectedEffort: undefined,
    expectedEffort: undefined,
    sentEffort: undefined,
    ...overrides,
  }
}

function judge(overrides: Partial<TurnObservation> = {}, tiers: Record<string, number> = {}): Verdict {
  return judgeTurn(turn(overrides), createIdentityResolver({ tiers }))
}

function codes(verdict: Verdict): string[] {
  return verdict.findings.map(finding => finding.code)
}

describe('judgeTurn model ladder', () => {
  it('reports silence as silence when nothing names a served model', () => {
    const verdict = judge()

    expect(verdict).toMatchObject({ outcome: 'unverified', level: 'warn' })
    expect(verdict.findings[0]?.code).toBe('UNVERIFIED')
    expect(isSubstitution(verdict)).toBe(false)
  })

  it('distinguishes headers that arrived but named nothing from no headers at all', () => {
    expect(judge({ sawRoutingHeaders: true }).findings[0]?.message).toContain('carried routing headers')
    expect(judge().findings[0]?.message).toContain('missing evidence')
  })

  it('passes an exact match', () => {
    const verdict = judge({ servedModel: 'gpt-6-astra' })

    expect(verdict).toMatchObject({ outcome: 'match', level: 'ok', direction: undefined })
    expect(codes(verdict)).toEqual(['MODEL_MATCH'])
  })

  it('flags a server-side variant suffix rather than shrugging at it', () => {
    const verdict = judge({ requestedModel: 'gpt-5.6-sol', servedModel: 'gpt-5.6-sol-codex-abuse-1p' })

    expect(verdict).toMatchObject({ outcome: 'substituted', level: 'warn', direction: 'lateral' })
    expect(codes(verdict)).toContain('MODEL_VARIANT')
  })

  it('rejects a served slug that parses as nothing at all', () => {
    const verdict = judge({ servedModel: 'housemodel' })

    expect(verdict.level).toBe('critical')
    expect(codes(verdict)).toContain('MODEL_UNRECOGNIZED')
  })

  it('calls an OpenAI request answered by another vendor a substitution, not a tier change', () => {
    const verdict = judge({ servedModel: 'claude-opus-5' })

    expect(verdict.level).toBe('critical')
    expect(codes(verdict)).toContain('VENDOR_MISMATCH')
  })

  it('reports a lower-ranked served model as a critical downgrade', () => {
    const verdict = judge({ servedModel: 'gpt-5.6-luna' })

    expect(verdict).toMatchObject({ outcome: 'substituted', level: 'critical', direction: 'lower' })
    expect(codes(verdict)).toContain('MODEL_SUBSTITUTED')
    expect(isSubstitution(verdict)).toBe(true)
  })

  it('still reports a higher-ranked served model, because it is not what was selected', () => {
    const verdict = judge({ requestedModel: 'gpt-5.4', servedModel: 'gpt-6-astra' })

    expect(verdict).toMatchObject({ outcome: 'substituted', level: 'warn', direction: 'higher' })
    expect(isSubstitution(verdict)).toBe(true)
  })

  it('infers a direction from the generation when neither slug is ranked', () => {
    expect(judge({ requestedModel: 'gpt-5.9-quasar', servedModel: 'gpt-5.8-quasar' }).direction).toBe('lower')
    expect(judge({ requestedModel: 'gpt-5.8-quasar', servedModel: 'gpt-5.9-quasar' }).direction).toBe('higher')
  })

  it('infers a direction from a size marker the request did not carry', () => {
    const verdict = judge({ requestedModel: 'gpt-5.9-alpha', servedModel: 'gpt-5.9-mini' })

    expect(verdict).toMatchObject({ direction: 'lower', level: 'critical' })
  })

  it('reads a larger-sibling marker as the other direction', () => {
    const verdict = judge({ requestedModel: 'gpt-5.9-mini', servedModel: 'gpt-5.9-pro' })

    expect(verdict).toMatchObject({ direction: 'higher', level: 'warn' })
  })

  it('commits to a mismatch when no rule orders the two slugs', () => {
    const verdict = judge({ servedModel: 'o3-mini' })

    expect(verdict).toMatchObject({ outcome: 'substituted', level: 'critical', direction: 'lateral' })
    expect(codes(verdict)).toContain('MODEL_MISMATCH')
  })

  it('lets configured tiers settle a direction the built-in table cannot', () => {
    const verdict = judge(
      { requestedModel: 'relay-house-a', servedModel: 'relay-house-b' },
      { 'relay-house-a': 50, 'relay-house-b': 10 },
    )

    expect(verdict.direction).toBe('lower')
  })
})

describe('judgeTurn supporting findings', () => {
  it('treats a fired faster-model fallback as proof the turn was rerouted', () => {
    const verdict = judge({ servedModel: 'gpt-5.6-luna', fasterFallbackModel: 'gpt-5.6-luna' })

    expect(codes(verdict)).toContain('SAFETY_BUFFERING_APPLIED')
    expect(isSubstitution(verdict)).toBe(true)
  })

  it('does not call the fallback fired when it names the model you already asked for', () => {
    const verdict = judge({ servedModel: 'gpt-6-astra', fasterFallbackModel: 'gpt-6-astra' })

    expect(codes(verdict)).toContain('SAFETY_BUFFERING_ARMED')
    expect(isSubstitution(verdict)).toBe(false)
  })

  it('still reports an armed fallback when the enabled header says false', () => {
    const verdict = judge({
      servedModel: 'gpt-6-astra',
      fasterFallbackModel: 'gpt-5.6-luna',
      bufferingEnabled: 'false',
    })

    expect(codes(verdict)).toContain('SAFETY_BUFFERING_ARMED')
    expect(verdict.level).toBe('warn')
  })

  it('catches an Anthropic-shaped response id under an OpenAI request', () => {
    const verdict = judge({
      servedModel: 'gpt-6-astra',
      responseId: 'msg_01abcdef',
      backendFamily: 'anthropic-messages',
    })

    expect(codes(verdict)).toContain('BACKEND_FAMILY_MISMATCH')
    expect(verdict.level).toBe('critical')
  })

  it('says so when the requested slug is ranked nowhere', () => {
    expect(codes(judge({ requestedModel: 'gpt-5.9-quasar', servedModel: 'gpt-5.9-quasar' }))).toContain(
      'REQUESTED_MODEL_UNRECORDED',
    )
  })

  it('says so when the name matches but nothing corroborates the slug', () => {
    expect(codes(judge({ requestedModel: 'gpt-5.9-quasar', servedModel: 'gpt-5.9-quasar' }))).toContain(
      'MODEL_UNRECORDED',
    )
  })
})

describe('judgeTurn effort axis', () => {
  it('reports effort sent below what the selected level maps to', () => {
    const verdict = judge({
      servedModel: 'gpt-6-astra',
      selectedEffort: 'xhigh',
      expectedEffort: 'xhigh',
      sentEffort: 'medium',
    })

    expect(verdict.effort).toMatchObject({ code: 'EFFORT_SUBSTITUTED', direction: 'lower', level: 'warn' })
    expect(verdict.effort?.message).toContain('not what the server used')
  })

  it('reports effort sent above it too', () => {
    const verdict = judge({
      servedModel: 'gpt-6-astra',
      selectedEffort: 'low',
      expectedEffort: 'low',
      sentEffort: 'high',
    })

    expect(verdict.effort).toMatchObject({ direction: 'higher' })
  })

  it('stays quiet when the model itself maps the level to that effort', () => {
    const verdict = judge({
      servedModel: 'gpt-6-astra',
      selectedEffort: 'xhigh',
      expectedEffort: 'high',
      sentEffort: 'high',
    })

    expect(verdict.effort).toBeUndefined()
    expect(verdict.level).toBe('ok')
  })

  it('stays quiet when either side is unknown', () => {
    expect(judge({ servedModel: 'gpt-6-astra', sentEffort: 'high' }).effort).toBeUndefined()
    expect(judge({ servedModel: 'gpt-6-astra', selectedEffort: 'high' }).effort).toBeUndefined()
  })

  it('reports an unrankable effort pair as lateral rather than guessing', () => {
    const verdict = judge({
      servedModel: 'gpt-6-astra',
      selectedEffort: 'high',
      expectedEffort: 'high',
      sentEffort: 'turbo',
    })

    expect(verdict.effort).toMatchObject({ direction: 'lateral' })
  })
})
