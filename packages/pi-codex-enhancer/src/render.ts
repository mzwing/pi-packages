import type { EnhancerConfig, EnhancerConfigPaths, PiTransport } from './config.js'
import type { Ticket } from './state.js'
import type { ThemeColor } from '@earendil-works/pi-coding-agent'
import { maskProxyUrl } from './config.js'
import { describeTurnState, TICKET_TTL_MS, ticketAgeMs } from './state.js'

/** The slice of Pi's `Theme` the footer needs; `ctx.ui.theme` satisfies it. */
export interface StatusTheme {
  fg: (color: ThemeColor, text: string) => string
}

export type StatusKind = 'good' | 'minting' | 'degraded' | 'missing' | 'unsupported'
export type AlertKind = 'degraded' | 'transport' | 'unreachable'

export interface StatusView {
  kind: StatusKind
  remainingMs?: number | undefined
}

export interface ReportView {
  config: EnhancerConfig
  paths: EnhancerConfigPaths | undefined
  storePath: string
  transport: PiTransport
  ticket: Ticket | undefined
  now: number
  lastOutcome: string | undefined
  nextProbeAt: number | undefined
}

const LABEL = 'codex+'
const KIND_COLORS: Record<StatusKind, ThemeColor> = {
  good: 'success',
  minting: 'dim',
  degraded: 'error',
  missing: 'warning',
  unsupported: 'dim',
}
const KIND_GLYPHS: Record<StatusKind, string> = {
  good: '✓',
  minting: '…',
  degraded: '⚠',
  missing: '?',
  unsupported: '·',
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000)

  return minutes < 1 ? '<1m' : `${minutes}m`
}

function kindText(view: StatusView): string {
  if (view.kind === 'good') {
    return view.remainingMs === undefined ? '292' : `292 · ${formatDuration(view.remainingMs)} left`
  }
  if (view.kind === 'minting') {
    return 'minting'
  }
  if (view.kind === 'degraded') {
    return 'degraded'
  }

  return view.kind === 'missing' ? 'no state' : 'not gated'
}

/** The footer line. Always present, so "no state" is stated rather than implied to be fine. */
export function renderStatus(view: StatusView, theme: StatusTheme): string {
  const color = KIND_COLORS[view.kind]

  return `${theme.fg(color, KIND_GLYPHS[view.kind])} ${theme.fg('dim', LABEL)} ${theme.fg(color, kindText(view))}`
}

export function renderAlert(kind: AlertKind, detail: string): string {
  if (kind === 'transport') {
    return `${LABEL}: pi's transport is ${detail}, so the turn state only reaches the backend on a new connection — set "transport": "sse" in pi's settings`
  }
  if (kind === 'unreachable') {
    return `${LABEL}: could not mint a turn state — ${detail}`
  }

  return `${LABEL}: the backend returned a degraded turn state (${detail}); it has been dropped and will be re-minted`
}

/** The `/codex-enhancer` body. Prints what the state is, never the state itself. */
export function renderReport(view: ReportView): string {
  const { config, ticket } = view
  const lines = [
    `enabled    : ${config.enabled}`,
    `providers  : ${config.providers.length > 0 ? config.providers.join(', ') : '(every codex provider)'}`,
    `transport  : ${view.transport}${view.transport === 'sse' ? '' : ' (only a new connection carries the header)'}`,
    `ticket     : ${
      ticket === undefined
        ? '(none)'
        : `${describeTurnState(ticket.value)}, ${formatDuration(TICKET_TTL_MS - ticketAgeMs(ticket, view.now))} left, from ${ticket.source}, minted for ${ticket.model}`
    }`,
    `last probe : ${view.lastOutcome ?? '(none yet)'}`,
    `next probe : ${
      view.nextProbeAt === undefined || view.nextProbeAt <= view.now
        ? 'allowed now'
        : `in ${formatDuration(view.nextProbeAt - view.now)}`
    }`,
    '',
    `timeout    : ${config.probeTimeoutMs}ms`,
    `interval   : ${config.minProbeIntervalMs}ms`,
    `proxy      : ${maskProxyUrl(config.probeProxyUrl) || '(none)'}`,
    `notify     : ${config.notify}`,
    '',
    `tickets : ${view.storePath}`,
    `global  : ${view.paths?.globalPath ?? '(unknown until the session starts)'}`,
    `project : ${view.paths?.projectPath ?? '(unknown until the session starts)'}`,
  ]

  return lines.join('\n')
}
