import type { TurnObservation } from '../src/observe.js'
import type { Verdict } from '../src/verdict.js'
import { describe, expect, it } from 'vitest'
import { createIdentityResolver } from '../src/identity.js'
import { renderAlert, renderReport, renderStatus } from '../src/render.js'
import { judgeTurn } from '../src/verdict.js'
import { PLAIN_THEME } from './helpers.js'

function verdict(overrides: Partial<TurnObservation> = {}): Verdict {
  return judgeTurn(
    {
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
    },
    createIdentityResolver(),
  )
}

function status(overrides: Partial<TurnObservation> = {}): string {
  return renderStatus(verdict(overrides), PLAIN_THEME)
}

describe('renderStatus', () => {
  it('shows the served model on a clean turn, so the check is visibly running', () => {
    expect(status({ servedModel: 'gpt-6-astra', servedModelSource: 'header' })).toBe('✓ codex gpt-6-astra')
  })

  it('points the arrow down on a downgrade', () => {
    expect(status({ servedModel: 'gpt-5.6-luna', servedModelSource: 'header' })).toBe(
      '↓ codex gpt-6-astra→gpt-5.6-luna',
    )
  })

  it('points the arrow up on an upgrade', () => {
    expect(status({ requestedModel: 'gpt-5.4', servedModel: 'gpt-6-astra', servedModelSource: 'header' })).toBe(
      '↑ codex gpt-5.4→gpt-6-astra',
    )
  })

  it('uses an inequality sign when no rule orders the two', () => {
    expect(status({ servedModel: 'claude-opus-5', servedModelSource: 'header' })).toBe(
      '⚠ codex gpt-6-astra≠claude-opus-5',
    )
  })

  it('says unverified rather than showing a clean turn', () => {
    expect(status()).toBe('? codex gpt-6-astra unverified')
  })

  it('appends the effort pair when only effort diverged', () => {
    expect(
      status({
        servedModel: 'gpt-6-astra',
        servedModelSource: 'header',
        selectedEffort: 'xhigh',
        expectedEffort: 'xhigh',
        sentEffort: 'medium',
      }),
    ).toBe('⚠ codex gpt-6-astra · xhigh→medium')
  })
})

describe('renderAlert', () => {
  it('leads with the finding that drove the verdict', () => {
    expect(renderAlert(verdict({ servedModel: 'gpt-5.6-luna' }))).toContain("served 'gpt-5.6-luna'")
  })
})

describe('renderReport', () => {
  it('says plainly when nothing has been observed', () => {
    expect(renderReport([])).toBe('No provider responses observed yet in this session.')
  })

  it('names which signal supplied the served model on each turn', () => {
    const report = renderReport([
      verdict({ servedModel: 'gpt-6-astra', servedModelSource: 'header' }),
      verdict({ servedModel: 'gpt-5.5', servedModelSource: 'responseModel' }),
      verdict({ sawRoutingHeaders: true }),
      verdict(),
    ])

    expect(report).toContain('4 turn(s) observed, newest last.')
    expect(report).toContain('(openai-model header)')
    expect(report).toContain('(response model field)')
    expect(report).toContain('(routing headers, but none named a model)')
    expect(report).toContain('(no served-model signal)')
  })

  it('lists the findings behind a substitution but not the bare match', () => {
    const report = renderReport([
      verdict({ servedModel: 'gpt-6-astra', servedModelSource: 'header' }),
      verdict({ servedModel: 'gpt-5.6-luna', servedModelSource: 'header' }),
    ])

    expect(report).not.toContain('MODEL_MATCH')
    expect(report).toContain('MODEL_SUBSTITUTED')
  })
})
