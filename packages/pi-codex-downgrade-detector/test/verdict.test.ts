import type { TurnObservation } from '../src/observe.js'
import type { Verdict } from '../src/verdict.js'
import { describe, expect, it } from 'vitest'
import { createIdentityResolver } from '../src/identity.js'
import { isSubstitution, judgeTurn } from '../src/verdict.js'

function judge(overrides: Partial<TurnObservation>, tiers: Record<string, number> = {}): Verdict {
  const turn: TurnObservation = {
    requestedModel: 'gpt-6-astra',
    servedModel: undefined,
    servedModelSource: 'header',
    fasterFallbackModel: undefined,
    sawRoutingHeaders: true,
    responseId: undefined,
    selectedEffort: undefined,
    expectedEffort: undefined,
    sentEffort: undefined,
    ...overrides,
  }

  return judgeTurn(turn, createIdentityResolver(tiers, []))
}

function codes(verdict: Verdict): string[] {
  return verdict.findings.map(finding => finding.code)
}

describe('model ladder', () => {
  it('flags a server-side variant suffix rather than shrugging at it', () => {
    const verdict = judge({ requestedModel: 'gpt-5.6-sol', servedModel: 'gpt-5.6-sol-codex-abuse-1p' })

    expect(verdict).toMatchObject({ outcome: 'substituted', level: 'warn', direction: 'lateral' })
    expect(codes(verdict)).toContain('MODEL_VARIANT')
  })

  it('rejects a served slug that parses as nothing at all', () => {
    expect(codes(judge({ servedModel: 'housemodel' }))).toContain('MODEL_UNRECOGNIZED')
  })

  it('calls an OpenAI request answered by another vendor a substitution, not a tier change', () => {
    expect(codes(judge({ servedModel: 'claude-opus-5' }))).toContain('VENDOR_MISMATCH')
  })

  // Being handed something cheaper is the failure worth stopping for; an upgrade still is not what you picked.
  it('rates a downgrade critical and an upgrade a warning, both as substitutions', () => {
    const down = judge({ servedModel: 'gpt-5.6-luna' })
    const up = judge({ requestedModel: 'gpt-5.4', servedModel: 'gpt-6-astra' })

    expect(down).toMatchObject({ outcome: 'substituted', level: 'critical', direction: 'lower' })
    expect(up).toMatchObject({ outcome: 'substituted', level: 'warn', direction: 'higher' })
    expect(isSubstitution(up)).toBe(true)
  })

  it('orders OpenAI classes astra > sol > terra > luna before their version', () => {
    expect(judge({ requestedModel: 'gpt-6.1-sol', servedModel: 'gpt-6-astra' }).direction).toBe('higher')
    expect(judge({ requestedModel: 'gpt-7-sol', servedModel: 'gpt-7.1-luna' }).direction).toBe('lower')
    expect(judge({ requestedModel: 'gpt-7-terra', servedModel: 'gpt-6-sol' }).direction).toBe('higher')
    expect(judge({ requestedModel: 'gpt-7.1-sol', servedModel: 'gpt-7-sol' }).direction).toBe('lower')
  })

  it('infers a direction from the generation when neither slug is ranked', () => {
    expect(judge({ requestedModel: 'gpt-5.9-quasar', servedModel: 'gpt-5.8-quasar' }).direction).toBe('lower')
    expect(judge({ requestedModel: 'gpt-5.8-quasar', servedModel: 'gpt-5.9-quasar' }).direction).toBe('higher')
  })

  it('reads a smaller- or larger-sibling marker as a direction', () => {
    expect(judge({ requestedModel: 'gpt-5.9-alpha', servedModel: 'gpt-5.9-mini' }).direction).toBe('lower')
    expect(judge({ requestedModel: 'gpt-5.9-mini', servedModel: 'gpt-5.9-pro' }).direction).toBe('higher')
  })

  it('commits to a mismatch when no rule orders the two slugs', () => {
    const verdict = judge({ servedModel: 'o3-mini' })

    expect(verdict).toMatchObject({ outcome: 'substituted', level: 'critical', direction: 'lateral' })
    expect(codes(verdict)).toContain('MODEL_MISMATCH')
  })

  it('lets configured tiers settle a direction the built-in table cannot', () => {
    const tiers = { 'relay-house-a': 50, 'relay-house-b': 10 }

    expect(judge({ requestedModel: 'relay-house-a', servedModel: 'relay-house-b' }, tiers).direction).toBe('lower')
  })
})

describe('supporting findings', () => {
  it('treats a fired faster-model fallback as proof the turn was rerouted', () => {
    const verdict = judge({ servedModel: 'gpt-5.6-luna', fasterFallbackModel: 'gpt-5.6-luna' })

    expect(codes(verdict)).toContain('SAFETY_BUFFERING_APPLIED')
    expect(isSubstitution(verdict)).toBe(true)
  })

  it('reports an armed fallback without calling it fired, even when it names the model asked for', () => {
    for (const fasterFallbackModel of ['gpt-5.6-luna', 'gpt-6-astra']) {
      const verdict = judge({ servedModel: 'gpt-6-astra', fasterFallbackModel })

      expect(codes(verdict)).toContain('SAFETY_BUFFERING_ARMED')
      expect(isSubstitution(verdict)).toBe(false)
    }
  })

  it('catches an Anthropic-shaped response id under an OpenAI request', () => {
    const verdict = judge({ servedModel: 'gpt-6-astra', responseId: 'msg_01abcdef' })

    expect(codes(verdict)).toContain('BACKEND_FAMILY_MISMATCH')
    expect(verdict.level).toBe('critical')
  })

  it('says so when a matching slug is ranked nowhere, rather than passing it as fine', () => {
    expect(codes(judge({ requestedModel: 'gpt-5.9-quasar', servedModel: 'gpt-5.9-quasar' }))).toEqual([
      'MODEL_MATCH',
      'REQUESTED_MODEL_UNRECORDED',
      'MODEL_UNRECORDED',
    ])
  })
})
