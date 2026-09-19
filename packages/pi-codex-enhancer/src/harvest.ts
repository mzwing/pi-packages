import type { ProbeReply, ProbeTransport } from './probe.js'
import type { Ticket } from './state.js'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { arch, platform, release } from 'node:os'
import { mintTicket, ticketKey, TURN_STATE_HEADER } from './state.js'

/** Where the ChatGPT account id sits in the access token, as Pi's own Codex api reads it. */
const JWT_CLAIM = 'https://api.openai.com/auth'
const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api'
const FIRST_BACKOFF_MS = 30_000
const MAX_BACKOFF_MS = 900_000
const TRAILING_SLASHES = /\/+$/

type HarvestFailure = 'throttled' | 'unsupported' | 'degraded' | 'http-error' | 'network'

export type HarvestOutcome = { ok: true; ticket: Ticket } | { ok: false; reason: HarvestFailure; message: string }

export interface ProbeIdentity {
  accountId: string
  token: string
  baseUrl: string | undefined
  /** Headers Pi resolved for the model, kept so a relay's own headers still reach it. */
  headers: Record<string, string>
}

interface HarvestRequest {
  identity: ProbeIdentity
  model: string
  timeoutMs: number
  proxyUrl: string
  signal?: AbortSignal | undefined
  /** `/codex-enhancer refresh`: skips the interval and the backoff, never a probe already running. */
  force?: boolean | undefined
}

interface HarvesterDependencies {
  transport: ProbeTransport
  now?: (() => number) | undefined
  newSessionId?: (() => string) | undefined
  userAgent?: (() => string) | undefined
}

export interface HarvesterOptions {
  minIntervalMs: number
  dependencies: HarvesterDependencies
}

export interface Harvester {
  probe: (request: HarvestRequest) => Promise<HarvestOutcome>
  canProbe: (accountId: string, model: string) => boolean
  nextProbeAt: (accountId: string, model: string) => number | undefined
  isRunning: (accountId: string, model: string) => boolean
}

interface Throttle {
  nextAllowedAt: number
  backoffMs: number
  /** Set once a 200 comes back with no state header at all: this model does not mint one. */
  unsupported: boolean
}

/** Pi's `getPiUserAgent` is internal, so the probe recomputes the same string. */
export function defaultUserAgent(): string {
  return `pi (${platform()} ${release()}; ${arch()})`
}

/** Mirrors Pi's `resolveCodexUrl`, so a relay base URL is honoured instead of hard-coding OpenAI. */
export function resolveCodexProbeUrl(baseUrl: string | undefined): string {
  const raw = baseUrl !== undefined && baseUrl.trim().length > 0 ? baseUrl.trim() : DEFAULT_BASE_URL
  const normalized = raw.replace(TRAILING_SLASHES, '')
  if (normalized.endsWith('/codex/responses')) {
    return normalized
  }

  return normalized.endsWith('/codex') ? `${normalized}/responses` : `${normalized}/codex/responses`
}

/** Unlike Pi's `extractAccountId`, an opaque key is "no account" rather than a throw. */
export function extractAccountId(token: string): string | undefined {
  const payload = token.split('.')[1]
  if (payload === undefined) {
    return undefined
  }

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    const auth = claims[JWT_CLAIM]
    const accountId =
      typeof auth === 'object' && auth !== null ? (auth as Record<string, unknown>)['chatgpt_account_id'] : undefined

    return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined
  } catch {
    return undefined
  }
}

export function buildProbeBody(model: string): string {
  return JSON.stringify({
    model,
    store: false,
    stream: true,
    instructions: 'Reply with exactly: pong',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'ping' }] }],
  })
}

/**
 * The probe presents Pi's identity, not Codex CLI's. Pi hard-sets `originator` and `User-Agent`
 * after an extension's headers, so a state minted under any other identity would be replayed under
 * Pi's — the self-contradictory signal this extension exists to avoid.
 */
export function buildProbeHeaders(
  identity: ProbeIdentity,
  sessionId: string,
  userAgent: string,
): Record<string, string> {
  return {
    ...identity.headers,
    authorization: `Bearer ${identity.token}`,
    'chatgpt-account-id': identity.accountId,
    originator: 'pi',
    'user-agent': userAgent,
    'openai-beta': 'responses=experimental',
    accept: 'text/event-stream',
    'content-type': 'application/json',
    'session-id': sessionId,
    'x-client-request-id': sessionId,
  }
}

/**
 * Owns "may a probe run right now": single flight per key, a floor between probes, and a backoff that
 * decays a failing account instead of taxing every request. Callers cannot bypass it by accident.
 */
export function createHarvester(options: HarvesterOptions): Harvester {
  const { transport } = options.dependencies
  const now = options.dependencies.now ?? Date.now
  const newSessionId = options.dependencies.newSessionId ?? randomUUID
  const userAgent = options.dependencies.userAgent ?? defaultUserAgent
  const flights = new Map<string, Promise<HarvestOutcome>>()
  const throttles = new Map<string, Throttle>()

  function throttle(key: string): Throttle {
    const existing = throttles.get(key)
    if (existing !== undefined) {
      return existing
    }
    const created: Throttle = { nextAllowedAt: 0, backoffMs: 0, unsupported: false }
    throttles.set(key, created)

    return created
  }

  function succeed(key: string): void {
    const state = throttle(key)
    state.nextAllowedAt = now() + options.minIntervalMs
    state.backoffMs = 0
  }

  function fail(key: string): void {
    const state = throttle(key)
    state.backoffMs = Math.min(state.backoffMs === 0 ? FIRST_BACKOFF_MS : state.backoffMs * 2, MAX_BACKOFF_MS)
    state.nextAllowedAt = now() + state.backoffMs
  }

  async function run(request: HarvestRequest): Promise<HarvestOutcome> {
    const key = ticketKey(request.identity.accountId, request.model)
    let reply: ProbeReply
    try {
      reply = await transport({
        url: resolveCodexProbeUrl(request.identity.baseUrl),
        headers: buildProbeHeaders(request.identity, newSessionId(), userAgent()),
        body: buildProbeBody(request.model),
        timeoutMs: request.timeoutMs,
        proxyUrl: request.proxyUrl,
        signal: request.signal,
      })
    } catch (error) {
      fail(key)

      return { ok: false, reason: 'network', message: error instanceof Error ? error.message : String(error) }
    }

    const state = reply.headers[TURN_STATE_HEADER]
    if (reply.status !== 200) {
      fail(key)

      return { ok: false, reason: 'http-error', message: `probe answered HTTP ${reply.status}` }
    }
    if (state === undefined || state.trim().length === 0) {
      // Nothing to retry: this model simply does not mint a turn state.
      throttle(key).unsupported = true

      return { ok: false, reason: 'unsupported', message: 'the backend minted no turn state for this model' }
    }

    const ticket = mintTicket({
      accountId: request.identity.accountId,
      model: request.model,
      value: state,
      capturedAt: now(),
      source: 'probe',
    })
    if (ticket === undefined) {
      fail(key)

      return { ok: false, reason: 'degraded', message: `probe minted ${state.trim().length} chars, not 292` }
    }
    succeed(key)

    return { ok: true, ticket }
  }

  return {
    async probe(request) {
      const key = ticketKey(request.identity.accountId, request.model)
      const running = flights.get(key)
      if (running !== undefined) {
        return running
      }
      const state = throttle(key)
      if (state.unsupported) {
        return { ok: false, reason: 'unsupported', message: 'the backend minted no turn state for this model' }
      }
      if (request.force !== true && now() < state.nextAllowedAt) {
        const seconds = Math.ceil((state.nextAllowedAt - now()) / 1000)

        return { ok: false, reason: 'throttled', message: `next probe allowed in ${seconds}s` }
      }

      const flight = run(request)
      flights.set(key, flight)
      void flight.finally(() => flights.delete(key))

      return flight
    },
    canProbe(accountId, model) {
      const state = throttle(ticketKey(accountId, model))

      return !state.unsupported && now() >= state.nextAllowedAt
    },
    nextProbeAt(accountId, model) {
      const state = throttles.get(ticketKey(accountId, model))

      return state === undefined || state.nextAllowedAt === 0 ? undefined : state.nextAllowedAt
    },
    isRunning(accountId, model) {
      return flights.has(ticketKey(accountId, model))
    },
  }
}
