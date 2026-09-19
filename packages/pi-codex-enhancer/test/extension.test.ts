import type { EnhancerConfig, LoadConfigResult, PiTransport } from '../src/config.js'
import type { Harvester, HarvestOutcome } from '../src/harvest.js'
import type { Harness } from './helpers.js'
import type { ProviderHeaders } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import { createEnhancerExtension } from '../src/extension.js'
import { TURN_STATE_HEADER } from '../src/state.js'
import { TicketStore } from '../src/store.js'
import {
  codexModel,
  createHarness,
  createMemoryFileSystem,
  createRegistry,
  degradedState,
  goodState,
  makeToken,
  probeTicket,
} from './helpers.js'

const STORE_PATH = '/agent/tickets.json'

interface SetupOptions {
  config?: Partial<EnhancerConfig>
  outcomes?: HarvestOutcome[]
  transport?: PiTransport
  apiKey?: string
}

interface Setup {
  harness: Harness
  headers: ProviderHeaders
  probes: string[]
  store: TicketStore
  clock: { value: number }
  send: () => Promise<void>
  respond: (state: string | undefined, status?: number) => Promise<void>
}

function setup(options: SetupOptions = {}): Setup {
  const config: EnhancerConfig = { ...DEFAULT_CONFIG, ...options.config }
  const harness = createHarness(createRegistry({ ok: true, apiKey: options.apiKey ?? makeToken('acct-1') }))
  const headers: ProviderHeaders = {}
  const probes: string[] = []
  const clock = { value: 0 }
  const store = new TicketStore({ path: STORE_PATH, fileSystem: createMemoryFileSystem() })
  const outcomes = options.outcomes ?? [{ ok: true, ticket: probeTicket() }]
  let unsupported = false

  const harvester: Harvester = {
    probe: async request => {
      probes.push(request.model)
      const outcome = outcomes.shift() ?? { ok: false, reason: 'network', message: 'no outcome scripted' }
      if (!outcome.ok && outcome.reason === 'unsupported') {
        unsupported = true
      }

      return outcome
    },
    canProbe: () => !unsupported,
    nextProbeAt: () => undefined,
    isRunning: () => false,
  }

  createEnhancerExtension(harness.pi, {
    agentDir: '/agent',
    now: () => clock.value,
    warn: () => {},
    loadConfig: (): LoadConfigResult => ({
      config,
      issues: [],
      globalPath: '/agent/config.json',
      projectPath: '/workspace/config.json',
    }),
    readTransport: () => options.transport ?? 'sse',
    createStore: () => store,
    createHarvesterFor: () => harvester,
  })

  return {
    harness,
    headers,
    probes,
    store,
    clock,
    send: async () => harness.emit('before_provider_headers', { type: 'before_provider_headers', headers }),
    respond: async (state, status = 200) =>
      harness.emit('after_provider_response', {
        type: 'after_provider_response',
        status,
        headers: state === undefined ? {} : { [TURN_STATE_HEADER]: state },
      }),
  }
}

async function start(fixture: Setup): Promise<void> {
  await fixture.harness.emit('session_start', { type: 'session_start' })
}

describe('createEnhancerExtension', () => {
  it('mints and injects the state on the first request of a session', async () => {
    const fixture = setup()
    await start(fixture)
    await fixture.send()
    expect(fixture.probes).toEqual(['gpt-6-astra'])
    expect(fixture.headers[TURN_STATE_HEADER]).toBe(goodState())
  })

  it('reuses the minted state on the next request instead of probing again', async () => {
    const fixture = setup()
    await start(fixture)
    await fixture.send()
    await fixture.send()
    expect(fixture.probes).toHaveLength(1)
  })

  it('reads the state a sibling session left in the store', async () => {
    const fixture = setup({ outcomes: [{ ok: false, reason: 'network', message: 'should not be called' }] })
    fixture.store.write(probeTicket())
    await start(fixture)
    await fixture.send()
    expect(fixture.probes).toHaveLength(0)
    expect(fixture.headers[TURN_STATE_HEADER]).toBe(goodState())
  })

  it('leaves a request for another provider alone', async () => {
    const fixture = setup()
    fixture.harness.context.model = codexModel({ provider: 'openai', api: 'openai-responses' })
    await start(fixture)
    await fixture.send()
    expect(fixture.headers[TURN_STATE_HEADER]).toBeUndefined()
    expect(fixture.probes).toHaveLength(0)
  })

  it('leaves a request alone when the model does not speak the codex api', async () => {
    const fixture = setup()
    fixture.harness.context.model = codexModel({ api: 'openai-responses' })
    await start(fixture)
    await fixture.send()
    expect(fixture.headers[TURN_STATE_HEADER]).toBeUndefined()
  })

  it('stays out of the way when disabled', async () => {
    const fixture = setup({ config: { enabled: false } })
    await start(fixture)
    await fixture.send()
    expect(fixture.probes).toHaveLength(0)
    expect(fixture.headers[TURN_STATE_HEADER]).toBeUndefined()
  })

  it('sends the request without the header when nothing could be minted', async () => {
    const fixture = setup({ outcomes: [{ ok: false, reason: 'network', message: 'socket hang up' }] })
    await start(fixture)
    await fixture.send()
    expect(fixture.headers[TURN_STATE_HEADER]).toBeUndefined()
    expect(fixture.harness.ui.statuses.at(-1)).toBe('? codex+ no state')
  })

  it('captures a good state from a real response without spending a probe', async () => {
    const fixture = setup({ outcomes: [{ ok: false, reason: 'network', message: 'no probe wanted' }] })
    await start(fixture)
    await fixture.send()
    await fixture.respond(goodState())
    expect(fixture.store.read('acct-1', 'gpt-6-astra', 0)?.source).toBe('response')
    expect(fixture.harness.ui.statuses.at(-1)).toBe('✓ codex+ 292 · 60m left')
  })

  it('drops the state and warns when a response carries a degraded one', async () => {
    const fixture = setup()
    await start(fixture)
    await fixture.send()
    await fixture.respond(degradedState())
    expect(fixture.harness.ui.statuses.at(-1)).toBe('⚠ codex+ degraded')
    expect(fixture.harness.ui.notifications.at(-1)?.message).toContain('312')
  })

  it('warns once per degraded state rather than once per response', async () => {
    const fixture = setup()
    await start(fixture)
    await fixture.respond(degradedState())
    await fixture.respond(degradedState())
    expect(fixture.harness.ui.notifications.filter(entry => entry.message.includes('degraded'))).toHaveLength(1)
  })

  it('ignores a response that carries no state header at all', async () => {
    const fixture = setup()
    await start(fixture)
    await fixture.send()
    const before = fixture.harness.ui.statuses.length
    await fixture.respond(undefined)
    expect(fixture.harness.ui.statuses).toHaveLength(before)
  })

  it("refuses to send one account's state on another account's request", async () => {
    const fixture = setup({ outcomes: [{ ok: false, reason: 'network', message: 'no probe wanted' }] })
    fixture.store.write(probeTicket({ accountId: 'acct-2' }))
    await start(fixture)
    await fixture.send()
    expect(fixture.headers[TURN_STATE_HEADER]).toBeUndefined()
  })

  it('refuses to send a state minted for another model', async () => {
    const fixture = setup({ outcomes: [{ ok: false, reason: 'network', message: 'no probe wanted' }] })
    fixture.store.write(probeTicket({ model: 'gpt-5.6-sol' }))
    await start(fixture)
    await fixture.send()
    expect(fixture.headers[TURN_STATE_HEADER]).toBeUndefined()
  })

  it('re-mints in the background once the hour is nearly up, still injecting what it holds', async () => {
    const fixture = setup({
      outcomes: [
        { ok: true, ticket: probeTicket() },
        { ok: true, ticket: probeTicket({ capturedAt: 3_100_000 }) },
      ],
    })
    await start(fixture)
    await fixture.send()
    fixture.clock.value = 3_100_000
    await fixture.send()
    expect(fixture.headers[TURN_STATE_HEADER]).toBe(goodState())
    expect(fixture.probes).toHaveLength(2)
  })

  it('reports a model the backend does not gate instead of retrying it', async () => {
    const fixture = setup({
      outcomes: [{ ok: false, reason: 'unsupported', message: 'the backend minted no turn state for this model' }],
    })
    await start(fixture)
    await fixture.send()
    await fixture.send()
    expect(fixture.probes).toHaveLength(1)
    expect(fixture.harness.ui.statuses.at(-1)).toBe('· codex+ not gated')
  })

  it('tells the user once that the websocket transport cannot carry the header', async () => {
    const fixture = setup({ transport: 'auto' })
    await start(fixture)
    await fixture.send()
    await fixture.send()
    expect(fixture.harness.ui.notifications.filter(entry => entry.message.includes('"transport": "sse"'))).toHaveLength(
      1,
    )
  })

  it('stays silent about the transport when it is already sse', async () => {
    const fixture = setup()
    await start(fixture)
    expect(fixture.harness.ui.notifications).toHaveLength(0)
  })

  it('survives a registry that cannot resolve auth', async () => {
    const harness = createHarness(createRegistry({ ok: false, error: 'not logged in' }))
    const headers: ProviderHeaders = {}
    createEnhancerExtension(harness.pi, {
      agentDir: '/agent',
      now: () => 0,
      warn: () => {},
      loadConfig: () => ({ config: DEFAULT_CONFIG, issues: [], globalPath: 'g', projectPath: 'p' }),
      readTransport: () => 'sse',
      createStore: () => new TicketStore({ path: STORE_PATH, fileSystem: createMemoryFileSystem() }),
    })
    await harness.emit('session_start', { type: 'session_start' })
    await harness.emit('before_provider_headers', { type: 'before_provider_headers', headers })
    expect(headers[TURN_STATE_HEADER]).toBeUndefined()
  })

  it('survives a credential that is not a ChatGPT token', async () => {
    const fixture = setup({ apiKey: 'sk-plain-api-key' })
    await start(fixture)
    await fixture.send()
    expect(fixture.headers[TURN_STATE_HEADER]).toBeUndefined()
    expect(fixture.probes).toHaveLength(0)
  })

  it('clears the footer on shutdown', async () => {
    const fixture = setup()
    await start(fixture)
    await fixture.send()
    await fixture.harness.emit('session_shutdown', { type: 'session_shutdown' })
    expect(fixture.harness.ui.statuses.at(-1)).toBeUndefined()
  })

  it('clears the footer when the user selects a model it does not watch', async () => {
    const fixture = setup()
    await start(fixture)
    await fixture.send()
    fixture.harness.context.model = codexModel({ api: 'openai-responses' })
    await fixture.harness.emit('model_select', { type: 'model_select' })
    expect(fixture.harness.ui.statuses.at(-1)).toBeUndefined()
  })

  it('registers its command', async () => {
    const fixture = setup()
    await start(fixture)
    expect(fixture.harness.commands.has('codex-enhancer')).toBe(true)
  })
})
