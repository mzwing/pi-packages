import type { Harvester, HarvestOutcome, ProbeIdentity } from '../src/harvest.js'
import type { ProbeCall, ProbeReply } from '../src/probe.js'
import { describe, expect, it } from 'vitest'
import {
  buildProbeBody,
  buildProbeHeaders,
  createHarvester,
  defaultUserAgent,
  extractAccountId,
  resolveCodexProbeUrl,
} from '../src/harvest.js'
import { TURN_STATE_HEADER } from '../src/state.js'
import { degradedState, goodState, makeToken } from './helpers.js'

const IDENTITY: ProbeIdentity = {
  accountId: 'acct-1',
  token: 'token-1',
  baseUrl: 'https://chatgpt.com/backend-api',
  headers: { 'x-relay': 'keep-me' },
}

interface Recorder {
  harvester: Harvester
  calls: ProbeCall[]
  clock: { value: number }
}

function createRecorder(replies: (ProbeReply | Error)[], minIntervalMs = 60_000): Recorder {
  const calls: ProbeCall[] = []
  const clock = { value: 0 }
  const harvester = createHarvester({
    minIntervalMs,
    dependencies: {
      now: () => clock.value,
      newSessionId: () => 'session-1',
      userAgent: () => 'pi (test)',
      transport: async call => {
        calls.push(call)
        const reply = replies.shift()
        if (reply === undefined) {
          throw new Error('no reply scripted')
        }
        if (reply instanceof Error) {
          throw reply
        }

        return reply
      },
    },
  })

  return { harvester, calls, clock }
}

function ok(state: string, status = 200): ProbeReply {
  return { status, headers: { [TURN_STATE_HEADER]: state } }
}

async function probe(harvester: Harvester, force = false): Promise<HarvestOutcome> {
  return harvester.probe({ identity: IDENTITY, model: 'gpt-6-astra', timeoutMs: 5000, proxyUrl: '', force })
}

describe('resolveCodexProbeUrl', () => {
  it('builds the same URL Pi builds for its own request', () => {
    expect(resolveCodexProbeUrl('https://chatgpt.com/backend-api')).toBe(
      'https://chatgpt.com/backend-api/codex/responses',
    )
  })

  it('appends the path only once when the base URL already names it', () => {
    expect(resolveCodexProbeUrl('https://relay.test/codex/responses')).toBe('https://relay.test/codex/responses')
    expect(resolveCodexProbeUrl('https://relay.test/codex')).toBe('https://relay.test/codex/responses')
  })

  it('ignores trailing slashes', () => {
    expect(resolveCodexProbeUrl('https://relay.test/api//')).toBe('https://relay.test/api/codex/responses')
  })

  it('falls back to the ChatGPT backend when no base URL is given', () => {
    expect(resolveCodexProbeUrl(undefined)).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(resolveCodexProbeUrl('  ')).toBe('https://chatgpt.com/backend-api/codex/responses')
  })
})

describe('extractAccountId', () => {
  it('reads the account out of the token claim', () => {
    expect(extractAccountId(makeToken('acct-9'))).toBe('acct-9')
  })

  it('returns nothing for an opaque key instead of throwing', () => {
    expect(extractAccountId('sk-not-a-jwt')).toBeUndefined()
  })

  it('returns nothing when the claim is absent', () => {
    expect(extractAccountId('header.eyJzdWIiOiJ1c2VyIn0.signature')).toBeUndefined()
  })
})

describe('buildProbeHeaders', () => {
  it("presents Pi's identity, because the minted state must match what Pi sends", () => {
    const headers = buildProbeHeaders(IDENTITY, 'session-1', 'pi (test)')
    expect(headers['originator']).toBe('pi')
    expect(headers['user-agent']).toBe('pi (test)')
    expect(headers['authorization']).toBe('Bearer token-1')
    expect(headers['chatgpt-account-id']).toBe('acct-1')
  })

  it('spells the session header the way Pi spells it', () => {
    const headers = buildProbeHeaders(IDENTITY, 'session-1', 'pi (test)')
    expect(headers['session-id']).toBe('session-1')
    expect(headers['x-client-request-id']).toBe('session-1')
    expect(headers['session_id']).toBeUndefined()
  })

  it("keeps the model's own headers and lets Pi's identity win over them", () => {
    const headers = buildProbeHeaders(
      { ...IDENTITY, headers: { 'x-relay': 'keep-me', originator: 'codex' } },
      's',
      'ua',
    )
    expect(headers['x-relay']).toBe('keep-me')
    expect(headers['originator']).toBe('pi')
  })
})

describe('buildProbeBody', () => {
  it('asks for one streamed token and stores nothing', () => {
    expect(JSON.parse(buildProbeBody('gpt-6-astra'))).toEqual({
      model: 'gpt-6-astra',
      store: false,
      stream: true,
      instructions: 'Reply with exactly: pong',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
    })
  })
})

describe('defaultUserAgent', () => {
  it('reproduces the shape Pi sends', () => {
    expect(defaultUserAgent()).toMatch(/^pi \([^()]+\)$/)
  })
})

describe('createHarvester', () => {
  it('accepts a 292-character state on a 200 response', async () => {
    const { harvester } = createRecorder([ok(goodState())])
    const outcome = await probe(harvester)
    expect(outcome.ok).toBe(true)
  })

  it('rejects a 292-character state on a non-200 response', async () => {
    const { harvester } = createRecorder([ok(goodState(), 429)])
    const outcome = await probe(harvester)
    expect(outcome).toMatchObject({ ok: false, reason: 'http-error' })
  })

  it('rejects a state of the wrong length and says what it saw', async () => {
    const { harvester } = createRecorder([ok(degradedState())])
    const outcome = await probe(harvester)
    expect(outcome).toMatchObject({ ok: false, reason: 'degraded' })
    expect(outcome.ok ? '' : outcome.message).toContain('312')
  })

  it('treats a 200 with no state header as a model the backend does not gate', async () => {
    const { harvester } = createRecorder([{ status: 200, headers: {} }])
    expect(await probe(harvester)).toMatchObject({ ok: false, reason: 'unsupported' })
  })

  it('never probes again for a model the backend does not gate', async () => {
    const { harvester, calls } = createRecorder([{ status: 200, headers: {} }, ok(goodState())])
    await probe(harvester)
    await probe(harvester, true)
    expect(calls).toHaveLength(1)
    expect(harvester.canProbe('acct-1', 'gpt-6-astra')).toBe(false)
  })

  it('reports a transport failure as a network failure', async () => {
    const { harvester } = createRecorder([new Error('socket hang up')])
    expect(await probe(harvester)).toMatchObject({ ok: false, reason: 'network', message: 'socket hang up' })
  })

  it('runs one probe at a time per key and hands both callers the same outcome', async () => {
    const { harvester, calls } = createRecorder([ok(goodState())])
    const [first, second] = await Promise.all([probe(harvester), probe(harvester)])
    expect(calls).toHaveLength(1)
    expect(first).toBe(second)
  })

  it('refuses a second probe inside the minimum interval', async () => {
    const { harvester, calls, clock } = createRecorder([ok(goodState()), ok(goodState())])
    await probe(harvester)
    clock.value = 59_999
    expect(await probe(harvester)).toMatchObject({ ok: false, reason: 'throttled' })
    clock.value = 60_000
    await probe(harvester)
    expect(calls).toHaveLength(2)
  })

  it('lets a forced probe past the minimum interval', async () => {
    const { harvester, calls } = createRecorder([ok(goodState()), ok(goodState())])
    await probe(harvester)
    await probe(harvester, true)
    expect(calls).toHaveLength(2)
  })

  it('backs off further after each failure and clears the backoff on success', async () => {
    const { harvester, clock } = createRecorder([new Error('first'), new Error('second'), ok(goodState())])
    await probe(harvester)
    expect(harvester.nextProbeAt('acct-1', 'gpt-6-astra')).toBe(30_000)
    clock.value = 30_000
    await probe(harvester)
    expect(harvester.nextProbeAt('acct-1', 'gpt-6-astra')).toBe(90_000)
    clock.value = 90_000
    await probe(harvester)
    expect(harvester.nextProbeAt('acct-1', 'gpt-6-astra')).toBe(150_000)
  })

  it('sends the probe to the URL and headers it built', async () => {
    const { harvester, calls } = createRecorder([ok(goodState())])
    await probe(harvester)
    expect(calls[0]?.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(calls[0]?.headers['session-id']).toBe('session-1')
  })
})
