import type { EnhancerConfig, EnhancerConfigPaths, LoadConfigResult, PiTransport } from './config.js'
import type { Harvester, HarvestOutcome, ProbeIdentity } from './harvest.js'
import type { StatusKind } from './render.js'
import type { Ticket } from './state.js'
import type { TicketStore } from './store.js'
import type { Api, Model, ProviderHeaders } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { registerEnhancerCommand } from './command.js'
import {
  DEFAULT_CONFIG,
  defaultEnhancerAgentDir,
  EXTENSION_ID,
  getEnhancerConfigPaths,
  getTicketStorePath,
  loadEnhancerConfig,
  readPiTransport,
} from './config.js'
import { createHarvester, extractAccountId } from './harvest.js'
import { createProbeTransport } from './probe.js'
import { renderAlert, renderStatus } from './render.js'
import {
  classifyTurnState,
  isUsable,
  mintTicket,
  needsRefresh,
  newerTicket,
  TICKET_TTL_MS,
  ticketAgeMs,
  TURN_STATE_HEADER,
} from './state.js'
import { TicketStore as DefaultTicketStore } from './store.js'

/** Pi refreshes the token itself, so re-reading the credential every request buys nothing. */
const AUTH_CACHE_MS = 60_000
const CODEX_API = 'openai-codex-responses'

export interface EnhancerExtensionDependencies {
  loadConfig?: ((cwd: string, agentDir: string) => LoadConfigResult) | undefined
  readTransport?: ((cwd: string, agentDir: string) => PiTransport) | undefined
  createStore?: ((agentDir: string) => TicketStore) | undefined
  createHarvesterFor?: ((config: EnhancerConfig) => Harvester) | undefined
  agentDir?: string | undefined
  now?: (() => number) | undefined
  warn?: ((message: string) => void) | undefined
}

function defaultWarn(message: string): void {
  console.warn(`[${EXTENSION_ID}] ${message}`)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readHeader(headers: Record<string, string>, name: string): string | undefined {
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name)

  return match?.[1]
}

/** `ProviderHeaders` can delete with `null`; the probe only sends what is actually set. */
function plainHeaders(...sources: (Record<string, string> | ProviderHeaders | undefined)[]): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      if (typeof value === 'string') {
        headers[name] = value
      }
    }
  }

  return headers
}

export function createEnhancerExtension(pi: ExtensionAPI, dependencies: EnhancerExtensionDependencies = {}): void {
  const warn = dependencies.warn ?? defaultWarn
  const now = dependencies.now ?? Date.now
  const agentDir = dependencies.agentDir ?? defaultEnhancerAgentDir()
  const loadConfig = dependencies.loadConfig ?? ((cwd, dir) => loadEnhancerConfig({ cwd, agentDir: dir }))
  const readTransport = dependencies.readTransport ?? ((cwd, dir) => readPiTransport({ cwd, agentDir: dir }))
  const createStore = dependencies.createStore ?? (dir => new DefaultTicketStore({ agentDir: dir }))
  const createHarvesterFor =
    dependencies.createHarvesterFor ??
    (settings =>
      createHarvester({
        minIntervalMs: settings.minProbeIntervalMs,
        dependencies: { transport: createProbeTransport(), now },
      }))

  let config: EnhancerConfig = DEFAULT_CONFIG
  let paths: EnhancerConfigPaths | undefined
  let transport: PiTransport = 'auto'
  let store: TicketStore | undefined
  let harvester: Harvester | undefined
  let ticket: Ticket | undefined
  let identity: ProbeIdentity | undefined
  let identityKey = ''
  let identityAt = 0
  let kind: StatusKind = 'missing'
  let lastOutcome: string | undefined
  let nextProbe: number | undefined
  const notified = new Set<string>()

  function reset(): void {
    ticket = undefined
    identity = undefined
    identityKey = ''
    identityAt = 0
    kind = 'missing'
    lastOutcome = undefined
    nextProbe = undefined
    notified.clear()
  }

  function watches(model: Model<Api> | undefined): model is Model<Api> {
    return (
      model !== undefined &&
      model.api === CODEX_API &&
      (config.providers.length === 0 || config.providers.includes(model.provider))
    )
  }

  function announce(context: ExtensionContext, key: string, message: string): void {
    if (!config.notify || notified.has(key)) {
      return
    }
    notified.add(key)
    context.ui.notify(message, 'warning')
  }

  function paint(context: ExtensionContext): void {
    const remaining = ticket === undefined ? undefined : TICKET_TTL_MS - ticketAgeMs(ticket, now())
    context.ui.setStatus(
      EXTENSION_ID,
      renderStatus(kind === 'good' ? { kind, remainingMs: remaining } : { kind }, context.ui.theme),
    )
  }

  async function resolveIdentity(context: ExtensionContext, model: Model<Api>): Promise<ProbeIdentity | undefined> {
    const key = `${model.provider} ${model.id}`
    if (identity !== undefined && identityKey === key && now() - identityAt < AUTH_CACHE_MS) {
      return identity
    }

    const resolved = await context.modelRegistry.getApiKeyAndHeaders(model)
    if (!resolved.ok || resolved.apiKey === undefined) {
      return undefined
    }
    const accountId = extractAccountId(resolved.apiKey)
    if (accountId === undefined) {
      return undefined
    }
    identity = {
      accountId,
      token: resolved.apiKey,
      baseUrl: resolved.baseUrl ?? model.baseUrl,
      headers: plainHeaders(model.headers, resolved.headers),
    }
    identityKey = key
    identityAt = now()

    return identity
  }

  function absorb(context: ExtensionContext, outcome: HarvestOutcome): void {
    if (outcome.ok) {
      ticket = outcome.ticket
      kind = 'good'
      lastOutcome = 'minted a 292-char state'
      try {
        store?.write(outcome.ticket)
      } catch (error) {
        warn(`could not persist the turn state: ${describeError(error)}`)
      }

      return
    }

    lastOutcome = outcome.message
    if (outcome.reason === 'unsupported') {
      kind = 'unsupported'

      return
    }
    if (outcome.reason === 'throttled') {
      return
    }
    kind = outcome.reason === 'degraded' ? 'degraded' : 'missing'
    announce(context, `probe:${outcome.reason}`, renderAlert('unreachable', outcome.message))
  }

  async function mint(context: ExtensionContext, model: string, force: boolean): Promise<void> {
    if (harvester === undefined) {
      return
    }
    const current = identity
    if (current === undefined) {
      return
    }
    if (!force && !harvester.canProbe(current.accountId, model)) {
      return
    }
    kind = 'minting'
    paint(context)
    absorb(
      context,
      await harvester.probe({
        identity: current,
        model,
        timeoutMs: config.probeTimeoutMs,
        proxyUrl: config.probeProxyUrl,
        signal: context.signal,
        force,
      }),
    )
    nextProbe = harvester.nextProbeAt(current.accountId, model)
  }

  pi.on('session_start', (_event, context) => {
    reset()
    paths = getEnhancerConfigPaths(context.cwd, agentDir)

    const loaded = loadConfig(context.cwd, agentDir)
    for (const issue of loaded.issues) {
      warn(`config issue at ${issue.sourcePath}: ${issue.message}`)
    }
    config = loaded.config ?? DEFAULT_CONFIG
    transport = readTransport(context.cwd, agentDir)
    store = createStore(agentDir)
    harvester = createHarvesterFor(config)
    context.ui.setStatus(EXTENSION_ID, undefined)

    if (config.enabled && transport !== 'sse') {
      announce(context, 'transport', renderAlert('transport', transport))
    }
  })

  pi.on('before_provider_headers', async (event, context) => {
    const model = context.model
    if (!config.enabled || !watches(model)) {
      return
    }

    try {
      const resolved = await resolveIdentity(context, model)
      if (resolved === undefined) {
        return
      }
      if (ticket !== undefined && (ticket.accountId !== resolved.accountId || ticket.model !== model.id)) {
        // A state minted for another account or model is exactly the contradictory signal to avoid.
        ticket = undefined
      }
      ticket = newerTicket(ticket, store?.read(resolved.accountId, model.id, now()))

      if (ticket !== undefined && isUsable(ticket, now())) {
        event.headers[TURN_STATE_HEADER] = ticket.value
        kind = 'good'
        paint(context)
        // The hour is nearly up: keep this request on the state we hold and replace it out of band.
        if (needsRefresh(ticket, now())) {
          void mint(context, model.id, false).catch(error => warn(`background mint failed: ${describeError(error)}`))
        }

        return
      }

      await mint(context, model.id, false)
      if (ticket !== undefined && isUsable(ticket, now())) {
        event.headers[TURN_STATE_HEADER] = ticket.value
      }
      paint(context)
    } catch (error) {
      warn(`could not attach a turn state: ${describeError(error)}`)
    }
  })

  pi.on('after_provider_response', (event, context) => {
    const model = context.model
    if (!config.enabled || !watches(model)) {
      return
    }
    const seen = readHeader(event.headers, TURN_STATE_HEADER)
    const verdict = classifyTurnState(seen)
    if (verdict === 'absent') {
      return
    }

    if (verdict === 'degraded') {
      ticket = undefined
      kind = 'degraded'
      lastOutcome = `response carried ${seen?.trim().length ?? 0} chars, not 292`
      announce(context, `degraded:${seen?.trim().length ?? 0}`, renderAlert('degraded', lastOutcome))
      paint(context)

      return
    }

    // A real response mints the same state a probe would, so an SSE session pays for at most one.
    const accountId = identity?.accountId
    if (accountId === undefined) {
      return
    }
    const captured = mintTicket({ accountId, model: model.id, value: seen, capturedAt: now(), source: 'response' })
    if (captured === undefined) {
      return
    }
    ticket = captured
    kind = 'good'
    try {
      store?.write(captured)
    } catch (error) {
      warn(`could not persist the turn state: ${describeError(error)}`)
    }
    paint(context)
  })

  pi.on('model_select', (_event, context) => {
    if (!config.enabled || !watches(context.model)) {
      context.ui.setStatus(EXTENSION_ID, undefined)

      return
    }
    kind = 'missing'
    paint(context)
  })

  pi.on('session_shutdown', (_event, context) => {
    context.ui.setStatus(EXTENSION_ID, undefined)
    reset()
  })

  registerEnhancerCommand(pi, {
    getReport: () => ({
      config,
      paths,
      storePath: store?.path() ?? getTicketStorePath(agentDir),
      transport,
      ticket,
      now: now(),
      lastOutcome,
      nextProbeAt: nextProbe,
    }),
    refresh: async context => {
      const model = context.model
      if (!watches(model)) {
        return 'The selected model does not speak the Codex api, so there is no turn state to mint.'
      }
      const resolved = await resolveIdentity(context, model)
      if (resolved === undefined) {
        return 'Could not resolve a ChatGPT account from the stored credential.'
      }
      await mint(context, model.id, true)
      paint(context)

      return lastOutcome ?? 'Nothing to report.'
    },
    forget: context => {
      const accountId = identity?.accountId
      const model = ticket?.model ?? context.model?.id
      ticket = undefined
      kind = 'missing'
      if (accountId === undefined || model === undefined) {
        return 'No turn state was held.'
      }
      try {
        store?.forget(accountId, model, now())
      } catch (error) {
        return `Could not clear the stored turn state: ${describeError(error)}`
      }

      return 'Dropped the stored turn state; the next request mints a new one.'
    },
  })
}
