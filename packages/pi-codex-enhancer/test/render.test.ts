import type { ReportView } from '../src/render.js'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import { renderAlert, renderReport, renderStatus } from '../src/render.js'
import { goodState, PLAIN_THEME } from './helpers.js'

function report(overrides: Partial<ReportView> = {}): ReportView {
  return {
    config: DEFAULT_CONFIG,
    paths: { globalPath: '/agent/config.json', projectPath: '/workspace/config.json' },
    storePath: '/agent/tickets.json',
    transport: 'sse',
    ticket: undefined,
    now: 0,
    lastOutcome: undefined,
    nextProbeAt: undefined,
    ...overrides,
  }
}

describe('renderStatus', () => {
  it('shows how long the state has left', () => {
    expect(renderStatus({ kind: 'good', remainingMs: 2_820_000 }, PLAIN_THEME)).toBe('✓ codex+ 292 · 47m left')
  })

  it('rounds a nearly expired state down to under a minute', () => {
    expect(renderStatus({ kind: 'good', remainingMs: 30_000 }, PLAIN_THEME)).toBe('✓ codex+ 292 · <1m left')
  })

  it('marks the footer while a probe is in flight', () => {
    expect(renderStatus({ kind: 'minting' }, PLAIN_THEME)).toBe('… codex+ minting')
  })

  it('says the state is missing rather than implying the turn is fine', () => {
    expect(renderStatus({ kind: 'missing' }, PLAIN_THEME)).toBe('? codex+ no state')
  })

  it('names a degraded state', () => {
    expect(renderStatus({ kind: 'degraded' }, PLAIN_THEME)).toBe('⚠ codex+ degraded')
  })

  it('says a model the backend does not gate is not gated', () => {
    expect(renderStatus({ kind: 'unsupported' }, PLAIN_THEME)).toBe('· codex+ not gated')
  })
})

describe('renderAlert', () => {
  it('tells the user which transport setting the header needs', () => {
    expect(renderAlert('transport', 'auto')).toContain('"transport": "sse"')
  })

  it('names the degraded state in the alert', () => {
    expect(renderAlert('degraded', '312 chars')).toContain('312 chars')
  })

  it('reports why nothing could be minted', () => {
    expect(renderAlert('unreachable', 'socket hang up')).toContain('socket hang up')
  })
})

describe('renderReport', () => {
  it('reports no ticket as no ticket', () => {
    expect(renderReport(report())).toContain('ticket     : (none)')
  })

  it('describes the held state without printing it', () => {
    const body = renderReport(
      report({
        ticket: { accountId: 'acct-1', model: 'gpt-6-astra', value: goodState(), capturedAt: 0, source: 'probe' },
        now: 600_000,
      }),
    )
    expect(body).toContain('292 chars, good')
    expect(body).toContain('50m left')
    expect(body).not.toContain(goodState())
  })

  it('warns in the report when the transport cannot carry the header', () => {
    expect(renderReport(report({ transport: 'auto' }))).toContain('only a new connection')
  })

  it('prints both config paths and the ticket file', () => {
    const body = renderReport(report())
    expect(body).toContain('/agent/config.json')
    expect(body).toContain('/workspace/config.json')
    expect(body).toContain('/agent/tickets.json')
  })

  it('masks the proxy password', () => {
    const body = renderReport(
      report({ config: { ...DEFAULT_CONFIG, probeProxyUrl: 'socks5h://user:secret@host:1080' } }),
    )
    expect(body).not.toContain('secret')
    expect(body).toContain('***')
  })

  it('says a probe is allowed now when nothing has throttled it', () => {
    expect(renderReport(report())).toContain('next probe : allowed now')
  })
})
