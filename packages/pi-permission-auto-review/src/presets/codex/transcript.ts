import type { SessionEvent } from '../session.js'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { approximateTokens, serializeUnknown, truncateToFit } from '../../text.js'
import { decodeSession } from '../session.js'

const MAX_RECENT_UNTRUSTED_ENTRIES = 40
const TRANSCRIPT_TOKENS = { message: 10_000, tool: 10_000 }
const ENTRY_TOKENS = { message: 2_000, tool: 1_000 }

type TranscriptKind = 'user' | 'user_interaction' | 'assistant' | 'tool'

interface TranscriptEntry {
  index: number
  kind: TranscriptKind
  label: string
  text: string
  truncated?: boolean
}

interface TranscriptStats {
  transcriptEntriesRetained: number
  transcriptEntriesOmitted: number
  transcriptEntriesTruncated: number
  directUserEntriesRetained: number
  directUserEntriesOmitted: number
  directUserEntriesTruncated: number
  userInteractionEntriesRetained: number
  userInteractionEntriesOmitted: number
  userInteractionEntriesTruncated: number
  latestTrustedEntryRetained: boolean
}

export interface RenderedTranscript {
  entries: string[]
  stats: TranscriptStats
}

function transcriptEntries(event: SessionEvent): TranscriptEntry[] {
  const { index } = event
  switch (event.kind) {
    case 'user':
      return [{ index, kind: 'user', label: 'user', text: event.text }]
    case 'assistant':
      return [{ index, kind: 'assistant', label: 'assistant', text: event.text }]
    case 'toolCall':
      return [{ index, kind: 'tool', label: `tool:${event.name}`, text: serializeUnknown(event.input) }]
    case 'toolResult':
      return event.text
        ? [{ index, kind: 'tool', label: `tool:${event.name}${event.isError ? ' (error)' : ''}`, text: event.text }]
        : []
    case 'interaction':
      return [
        {
          index,
          kind: 'user_interaction',
          label: `user_interaction:${event.name}`,
          text: JSON.stringify(event.answers),
        },
      ]
    case 'userBash':
      return [{ index, kind: 'tool', label: 'tool:user-bash', text: `${event.command}\n${event.output}` }]
    case 'note':
      return [{ index, kind: 'assistant', label: event.label, text: event.text }]
  }
}

function renderEntry(entry: TranscriptEntry): string {
  return JSON.stringify({ index: entry.index, source: entry.kind, label: entry.label, content: entry.text })
}

function pool(entry: TranscriptEntry): 'message' | 'tool' {
  return entry.kind === 'tool' ? 'tool' : 'message'
}

function pretruncate(entry: TranscriptEntry): TranscriptEntry {
  const text = truncateToFit(entry.text, ENTRY_TOKENS[pool(entry)] * 4, candidate =>
    renderEntry({ ...entry, text: candidate }),
  )

  return text === entry.text ? entry : { ...entry, text, truncated: true }
}

function isTrusted(entry: TranscriptEntry): boolean {
  return entry.kind === 'user' || entry.kind === 'user_interaction'
}

/**
 * Keeps the first and latest trusted records unconditionally, then other trusted records newest first, then the
 * newest untrusted ones; the untrusted cap never evicts an authorization that was already selected. A follow-up
 * review sees only the entries from `from` on, which still count an answer to a question asked before them
 */
export function renderTranscript(sessionEntries: SessionEntry[], from = 0): RenderedTranscript {
  const all = decodeSession(sessionEntries)
    .filter(event => event.index >= from)
    .flatMap(transcriptEntries)
    .map(pretruncate)
  const trusted = all.filter(isTrusted)
  const selected = new Set<TranscriptEntry>()
  const used = { message: 0, tool: 0 }
  const take = (entry: TranscriptEntry, force = false): boolean => {
    const tokens = approximateTokens(renderEntry(entry))
    if (!force && used[pool(entry)] + tokens > TRANSCRIPT_TOKENS[pool(entry)]) {
      return false
    }
    used[pool(entry)] += tokens
    selected.add(entry)

    return true
  }

  for (const anchor of [trusted[0], trusted.at(-1)]) {
    if (anchor !== undefined && !selected.has(anchor)) {
      take(anchor, true)
    }
  }
  for (const entry of trusted.toReversed()) {
    if (!selected.has(entry)) {
      take(entry)
    }
  }
  let untrustedRetained = 0
  for (const entry of all.toReversed()) {
    if (!isTrusted(entry) && untrustedRetained < MAX_RECENT_UNTRUSTED_ENTRIES && take(entry)) {
      untrustedRetained += 1
    }
  }

  const retained = all.filter(entry => selected.has(entry))
  const tally = (kind?: TranscriptKind): { retained: number; omitted: number; truncated: number } => {
    const matches = (entry: TranscriptEntry): boolean => kind === undefined || entry.kind === kind
    const kept = retained.filter(matches)

    return {
      retained: kept.length,
      omitted: all.filter(matches).length - kept.length,
      truncated: kept.filter(entry => entry.truncated === true).length,
    }
  }
  const total = tally()
  const user = tally('user')
  const interaction = tally('user_interaction')
  const latest = trusted.at(-1)

  return {
    entries: retained.map(renderEntry),
    stats: {
      transcriptEntriesRetained: total.retained,
      transcriptEntriesOmitted: total.omitted,
      transcriptEntriesTruncated: total.truncated,
      directUserEntriesRetained: user.retained,
      directUserEntriesOmitted: user.omitted,
      directUserEntriesTruncated: user.truncated,
      userInteractionEntriesRetained: interaction.retained,
      userInteractionEntriesOmitted: interaction.omitted,
      userInteractionEntriesTruncated: interaction.truncated,
      latestTrustedEntryRetained: latest !== undefined && selected.has(latest),
    },
  }
}
