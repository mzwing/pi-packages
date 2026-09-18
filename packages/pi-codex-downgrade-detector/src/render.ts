import type { TurnObservation } from './observe.js'
import type { Direction, FindingLevel, Verdict } from './verdict.js'
import type { ThemeColor } from '@earendil-works/pi-coding-agent'

/** The slice of Pi's `Theme` the footer needs; `ctx.ui.theme` satisfies it. */
export interface StatusTheme {
  fg: (color: ThemeColor, text: string) => string
}

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

  return verdict.effort === undefined ? '✓' : '⚠'
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

/** The footer line. Always present, so a clean turn proves the check actually ran. */
export function renderStatus(verdict: Verdict, theme: StatusTheme): string {
  const color = LEVEL_COLORS[verdict.level]
  const effort = verdict.effort === undefined ? '' : ` · ${verdict.turn.expectedEffort}→${verdict.turn.sentEffort}`

  return `${theme.fg(color, glyphFor(verdict))} ${theme.fg('dim', LABEL)} ${theme.fg(color, modelText(verdict) + effort)}`
}

/** One line for the notification that fires the first time a pair is substituted. */
export function renderAlert(verdict: Verdict): string {
  const finding = verdict.findings.find(candidate => candidate.level === 'critical') ?? verdict.findings[0]

  return `${LABEL}-downgrade: ${finding?.message ?? modelText(verdict)}`
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

/** The `/codex-downgrade` body. Absence of evidence is printed as absence of evidence. */
export function renderReport(verdicts: readonly Verdict[]): string {
  if (verdicts.length === 0) {
    return 'No provider responses observed yet in this session.'
  }

  const lines = [`${verdicts.length} turn(s) observed, newest last.`, '']
  for (const verdict of verdicts) {
    lines.push(`${glyphFor(verdict)} ${modelText(verdict)}  (${describeSource(verdict.turn)})`)
    for (const finding of verdict.findings) {
      if (finding.code !== 'MODEL_MATCH') {
        lines.push(`    ${finding.code}: ${finding.message}`)
      }
    }
  }

  return lines.join('\n')
}
