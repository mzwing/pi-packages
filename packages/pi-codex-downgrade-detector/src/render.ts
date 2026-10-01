import type { ConfigPaths, DetectorConfig } from './config.js'
import type { TurnObservation } from './observe.js'
import type { Direction, Finding, FindingLevel, Verdict } from './verdict.js'
import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent'

type StatusTheme = Pick<Theme, 'fg'>

const LABEL = 'codex'
const LEVEL_COLORS: Record<FindingLevel, ThemeColor> = {
  ok: 'success',
  info: 'dim',
  warn: 'warning',
  critical: 'error',
}
const DIRECTION_GLYPHS: Record<Direction, string> = { lower: '↓', higher: '↑', lateral: '⚠' }

function glyphFor(verdict: Verdict): string {
  if (verdict.outcome === 'unverified') {
    return '?'
  }
  if (verdict.outcome === 'substituted') {
    return verdict.direction === undefined ? '⚠' : DIRECTION_GLYPHS[verdict.direction]
  }

  // The slug matched, but an armed fallback or a remapped effort still has something to say.
  return verdict.level === 'warn' || verdict.level === 'critical' ? '⚠' : '✓'
}

function modelText(verdict: Verdict): string {
  const { requestedModel, servedModel } = verdict.turn
  if (verdict.outcome === 'unverified') {
    return `${requestedModel} unverified`
  }
  if (verdict.outcome === 'match' || servedModel === undefined) {
    return requestedModel
  }

  return `${requestedModel}${verdict.direction === 'lateral' ? '≠' : '→'}${servedModel}`
}

function bodyText(verdict: Verdict, findings: readonly Finding[]): string {
  return [modelText(verdict), ...findings.flatMap(finding => finding.note ?? [])].join(' · ')
}

function describeSource(turn: TurnObservation): string {
  if (turn.servedModelSource === 'header') {
    return 'openai-model header'
  }
  if (turn.servedModelSource === 'responseModel') {
    return 'response model field'
  }

  return turn.sawRoutingHeaders ? 'routing headers, but none named a model' : 'no served-model signal'
}

/** Every extension's status shares one hard-truncated footer line, so this stays one glyph wide. */
export function renderStatus(verdict: Verdict, theme: StatusTheme): string {
  return `${theme.fg(LEVEL_COLORS[verdict.level], glyphFor(verdict))} ${theme.fg('dim', LABEL)}`
}

export function renderWaitingStatus(theme: StatusTheme): string {
  return `${theme.fg('dim', '·')} ${theme.fg('dim', LABEL)}`
}

export function renderDetail(verdict: Verdict, theme: StatusTheme): string[] | undefined {
  const notable = verdict.findings.filter(finding => finding.level === 'warn' || finding.level === 'critical')
  if (verdict.outcome === 'unverified' || notable.length === 0) {
    return undefined
  }
  const color = LEVEL_COLORS[verdict.level]

  return [
    [
      theme.fg(color, glyphFor(verdict)),
      theme.fg('dim', LABEL),
      theme.fg(color, bodyText(verdict, notable)),
      theme.fg('dim', `(${describeSource(verdict.turn)})`),
    ].join(' '),
  ]
}

export function renderAlert(verdict: Verdict): string {
  return `${LABEL}-downgrade: ${bodyText(verdict, verdict.findings)}`
}

export function renderReport(verdicts: readonly Verdict[]): string {
  if (verdicts.length === 0) {
    return 'No provider responses observed yet in this session.'
  }

  const lines = [`${verdicts.length} turn(s) observed, newest last.`, '']
  for (const verdict of verdicts) {
    const codes = verdict.findings.filter(finding => finding.code !== 'MODEL_MATCH').map(finding => finding.code)
    lines.push(`${glyphFor(verdict)} ${bodyText(verdict, verdict.findings)}  (${describeSource(verdict.turn)})`)
    if (codes.length > 0) {
      lines.push(`    ${codes.join('  ')}`)
    }
  }

  return lines.join('\n')
}

export function renderConfig(config: DetectorConfig, paths: ConfigPaths): string {
  const tiers = Object.entries(config.tiers)

  return [
    `providers   : ${config.providers.length > 0 ? config.providers.join(', ') : '(every provider)'}`,
    `checkEffort : ${config.checkEffort}`,
    `notify      : ${config.notify}`,
    `tiers       : ${tiers.length > 0 ? tiers.map(([slug, rank]) => `${slug}=${rank}`).join(', ') : '(built-in only)'}`,
    '',
    `global  : ${paths.global}`,
    `project : ${paths.project}`,
  ].join('\n')
}
