import type { TranscriptCursor } from '../../reviewer/conversation.js'
import type { SessionEvent } from '../session.js'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { PromptPermissionDetails } from '@gotgenes/pi-permission-system'
import { approximateTokens, serializeUnknown, truncateToFit } from '../../text.js'
import { permissionRequest } from '../permission-request.js'
import { decodeSession } from '../session.js'

type ToolCall = Extract<SessionEvent, { kind: 'toolCall' }>
type Note = Extract<SessionEvent, { kind: 'note' }>

const READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls'])
const TRANSCRIPT_TOKENS = 20_000
const LINE_CHARACTERS = { user: 8_000, other: 4_000 }
// agent-core's result for a call an abort cut off
const ABORTED_RESULT = 'Operation aborted'
const NOTE_KEYS: Readonly<Record<Note['label'], string>> = {
  compaction: 'compaction_summary',
  compactionSummary: 'compaction_summary',
  branch_summary: 'branch_summary',
  branchSummary: 'branch_summary',
  custom: 'custom_message',
}
const LINE_KEYS = new Set([
  'user',
  'user_answer',
  'assistant',
  'outcome',
  'id',
  'user_bash',
  'omitted',
  'permission_request',
  ...Object.values(NOTE_KEYS),
])

export interface ClaudeCodeTranscript {
  /** JSONL lines, the action under review last */
  lines: string[]
  /** Where this rendering ended, which a follow-up continues after */
  cursor: TranscriptCursor | undefined
  stats: { transcriptLinesRetained: number; transcriptLinesOmitted: number; transcriptLinesTruncated: number }
}

interface Line {
  order: number
  text: string
  truncated: boolean
}

/** Lines kept or omitted together: a user message with the prose it answers, or a call with its outcome */
interface Unit {
  lines: Line[]
  fromUser: boolean
}

function toolKey(name: string): string {
  return LINE_KEYS.has(name) ? `tool:${name}` : name
}

/** How the transcript refers to a call, stable across the reviews of one conversation */
function transcriptId(call: ToolCall): string {
  return `${call.index}.${call.position}`
}

/** Branch order: an assistant message's text comes before its calls */
function precedes(event: SessionEvent, target: ToolCall): boolean {
  if (event.index !== target.index) {
    return event.index < target.index
  }

  return event.kind === 'assistant' || (event.kind === 'toolCall' && event.position < target.position)
}

/**
 * The branch up to the call that raised the ask, which is always the last line; with `after`, only what follows
 * that cursor. A user line always brings the agent prose it answers, even from before the cursor
 */
export function renderTranscript(
  entries: SessionEntry[],
  details: PromptPermissionDetails,
  after?: TranscriptCursor,
): ClaudeCodeTranscript {
  const events = decodeSession(entries)
  const target =
    details.toolCallId === undefined
      ? undefined
      : events.findLast((event): event is ToolCall => event.kind === 'toolCall' && event.id === details.toolCallId)
  const before = target === undefined ? events : events.filter(event => precedes(event, target))
  const afterIndex = after === undefined ? -1 : entries.findIndex(entry => entry.id === after.entryId)
  const afterCall =
    after?.toolCallId === undefined
      ? undefined
      : before.find(
          (event): event is ToolCall =>
            event.kind === 'toolCall' && event.index === afterIndex && event.id === after.toolCallId,
        )
  const unseen = (event: SessionEvent): boolean =>
    event.index > afterIndex ||
    (event.index === afterIndex &&
      event.kind === 'toolCall' &&
      afterCall !== undefined &&
      event.position > afterCall.position)

  let order = 0
  const line = (key: string, value: unknown, extra: Record<string, unknown>, maxCharacters: number): Line => {
    const render = (candidate: unknown): string => JSON.stringify({ [key]: candidate, ...extra })
    const full = render(value)
    order += 1
    if (full.length <= maxCharacters) {
      return { order, text: full, truncated: false }
    }

    return { order, text: render(truncateToFit(serializeUnknown(value), maxCharacters, render)), truncated: true }
  }

  const units: Unit[] = []
  // Calls shown in this rendering or an earlier one, with their unit when it is this one
  const shownCalls = new Map<string, { call: ToolCall; unit: Unit | undefined }>()
  let proposal: string | undefined
  for (const event of before) {
    switch (event.kind) {
      case 'assistant':
        proposal = event.text
        break
      case 'user':
        if (unseen(event)) {
          units.push({
            fromUser: true,
            lines: [
              ...(proposal === undefined ? [] : [line('assistant', proposal, {}, LINE_CHARACTERS.other)]),
              line('user', event.text, {}, LINE_CHARACTERS.user),
            ],
          })
        }
        proposal = undefined
        break
      case 'interaction':
        if (unseen(event)) {
          units.push({ fromUser: true, lines: [line('user_answer', event.answers, {}, LINE_CHARACTERS.user)] })
        }
        proposal = undefined
        break
      case 'toolCall':
        if (!READ_ONLY_TOOLS.has(event.name) && event.id !== undefined) {
          const unit = unseen(event)
            ? {
                fromUser: false,
                lines: [line(toolKey(event.name), event.input, { id: transcriptId(event) }, LINE_CHARACTERS.other)],
              }
            : undefined
          shownCalls.set(event.id, { call: event, unit })
          if (unit !== undefined) {
            units.push(unit)
          }
        }
        break
      case 'toolResult': {
        const shown = event.toolCallId === undefined ? undefined : shownCalls.get(event.toolCallId)
        if (shown === undefined || !unseen(event)) {
          break
        }
        const outcome = !event.isError ? 'ok' : event.text === ABORTED_RESULT ? 'interrupted' : 'error'
        const outcomeLine = line('outcome', outcome, { id: transcriptId(shown.call) }, LINE_CHARACTERS.other)
        if (shown.unit === undefined) {
          units.push({ fromUser: false, lines: [outcomeLine] })
        } else {
          shown.unit.lines.push(outcomeLine)
        }
        break
      }
      case 'userBash':
        if (!event.excluded && unseen(event)) {
          units.push({ fromUser: false, lines: [line('user_bash', event.command, {}, LINE_CHARACTERS.other)] })
        }
        break
      case 'note':
        if (unseen(event)) {
          units.push({ fromUser: false, lines: [line(NOTE_KEYS[event.label], event.text, {}, LINE_CHARACTERS.other)] })
        }
        break
    }
  }

  const selected = selectUnits(units)
  const rendered: string[] = []
  let omitted = 0
  const ordered = units
    .flatMap(unit => unit.lines.map(entry => ({ unit, entry })))
    .toSorted((left, right) => left.entry.order - right.entry.order)
  for (const current of ordered) {
    if (selected.has(current.unit)) {
      if (omitted > 0) {
        rendered.push(JSON.stringify({ omitted }))
        omitted = 0
      }
      rendered.push(current.entry.text)
    } else {
      omitted += 1
    }
  }
  if (omitted > 0) {
    rendered.push(JSON.stringify({ omitted }))
  }
  const action =
    target === undefined
      ? JSON.stringify({ permission_request: permissionRequest(details) })
      : JSON.stringify({ [toolKey(target.name)]: target.input, id: transcriptId(target) })
  const retained = [...selected].flatMap(unit => unit.lines)
  const lastEntry = target === undefined ? entries.at(-1) : entries[target.index]

  return {
    lines: [...rendered, action],
    cursor: lastEntry === undefined ? undefined : { entryId: lastEntry.id, toolCallId: target?.id },
    stats: {
      transcriptLinesRetained: retained.length,
      transcriptLinesOmitted: units.flatMap(unit => unit.lines).length - retained.length,
      transcriptLinesTruncated: retained.filter(entry => entry.truncated).length,
    },
  }
}

/** The first and latest user units unconditionally, then other user units newest first, then the newest others */
function selectUnits(units: Unit[]): Set<Unit> {
  const fromUser = units.filter(unit => unit.fromUser)
  const forced = new Set([fromUser[0], fromUser.at(-1)].filter(unit => unit !== undefined))
  const selected = new Set<Unit>()
  let used = 0
  for (const unit of [...forced, ...fromUser.toReversed(), ...units.toReversed()]) {
    const tokens = unit.lines.reduce((sum, entry) => sum + approximateTokens(entry.text), 0)
    if (selected.has(unit) || (!forced.has(unit) && used + tokens > TRANSCRIPT_TOKENS)) {
      continue
    }
    used += tokens
    selected.add(unit)
  }

  return selected
}
