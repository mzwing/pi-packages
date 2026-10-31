import type { SessionEntry } from '@earendil-works/pi-coding-agent'

const MAX_RECENT_UNTRUSTED_ENTRIES = 40
const TRANSCRIPT_TOKENS = { message: 10_000, tool: 10_000 }
const ENTRY_TOKENS = { message: 2_000, tool: 1_000 }
const TRUSTED_USER_INTERACTION_TOOLS = new Set(['ask_user_question', 'plan_mode_question'])

type TranscriptKind = 'user' | 'user_interaction' | 'assistant' | 'tool'

interface TranscriptEntry {
  index: number
  kind: TranscriptKind
  label: string
  text: string
  truncated?: boolean
}

export interface TranscriptStats {
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

// Persisted session data, so every field is decoded rather than trusted to match the current types.
interface ContentBlock {
  type?: unknown
  id?: unknown
  text?: unknown
  name?: unknown
  toolName?: unknown
  arguments?: unknown
}

interface MessageLike {
  role?: unknown
  content?: unknown
  command?: unknown
  output?: unknown
  summary?: unknown
  toolCallId?: unknown
  toolName?: unknown
  isError?: unknown
  details?: unknown
}

interface UserInteractionAnswer {
  question?: unknown
  answer?: unknown
  selected?: unknown
  notes?: unknown
}

export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function truncateToCharacters(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) {
    return text
  }
  const tag = '\n...[truncated]...\n'
  const available = Math.max(0, maxCharacters - tag.length)
  const headLength = Math.floor(available * 0.7)
  const tailLength = available - headLength

  // `slice(-0)` would return the whole string when the budget leaves no tail.
  return `${text.slice(0, headLength)}${tag}${text.slice(text.length - tailLength)}`
}

function serializeUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function normalizeAnswer(value: unknown): unknown {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return value
  }

  return Array.isArray(value) ? value.map(normalizeAnswer) : serializeUnknown(value)
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return serializeUnknown(content)
  }

  return content
    .map((block: ContentBlock) => {
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text
      }

      return block.type === 'image' ? '[image omitted]' : ''
    })
    .filter(Boolean)
    .join('\n')
}

function answerEvidence(answer: UserInteractionAnswer): unknown {
  const primary =
    answer.answer !== undefined && answer.answer !== null
      ? normalizeAnswer(answer.answer)
      : Array.isArray(answer.selected) && answer.selected.length > 0
        ? answer.selected.map(normalizeAnswer)
        : undefined
  const notes = typeof answer.notes === 'string' && answer.notes.length > 0 ? answer.notes : undefined
  if (primary === undefined || notes === undefined) {
    return primary ?? notes
  }

  return { selection: primary, notes }
}

/**
 * Only a completed, non-cancelled answer to a question tool the assistant actually called counts, rebuilt from
 * its structured details so free-form tool text is never promoted to user evidence.
 */
function userInteractionText(message: MessageLike, interactionCalls: ReadonlyMap<string, string>): string | undefined {
  const { toolName, toolCallId, details } = message
  if (
    typeof toolName !== 'string' ||
    typeof toolCallId !== 'string' ||
    !TRUSTED_USER_INTERACTION_TOOLS.has(toolName) ||
    interactionCalls.get(toolCallId) !== toolName ||
    message.isError !== false ||
    details === null ||
    typeof details !== 'object'
  ) {
    return undefined
  }
  const { cancelled, answers } = details as { cancelled?: unknown; answers?: unknown }
  if (cancelled !== false || !Array.isArray(answers) || answers.length === 0) {
    return undefined
  }

  const evidence: { question: string; answer: unknown }[] = []
  for (const answer of answers) {
    if (answer === null || typeof answer !== 'object') {
      return undefined
    }
    const { question } = answer as UserInteractionAnswer
    const value = answerEvidence(answer as UserInteractionAnswer)
    if (typeof question !== 'string' || question.length === 0 || value === undefined) {
      return undefined
    }
    evidence.push({ question, answer: value })
  }

  return JSON.stringify(evidence)
}

function entriesFromMessage(
  message: MessageLike,
  index: number,
  interactionCalls: Map<string, string>,
): TranscriptEntry[] {
  const entry = (kind: TranscriptKind, label: string, text: string): TranscriptEntry[] =>
    text ? [{ index, kind, label, text }] : []

  switch (message.role) {
    case 'user':
      return entry('user', 'user', textFromContent(message.content))
    case 'assistant': {
      const toolCalls = (Array.isArray(message.content) ? message.content : []).flatMap((block: ContentBlock) => {
        if (block.type !== 'toolCall') {
          return []
        }
        const name =
          typeof block.name === 'string' ? block.name : typeof block.toolName === 'string' ? block.toolName : 'unknown'
        if (typeof block.id === 'string' && TRUSTED_USER_INTERACTION_TOOLS.has(name)) {
          interactionCalls.set(block.id, name)
        }

        return [{ index, kind: 'tool' as const, label: `tool:${name}`, text: serializeUnknown(block.arguments) }]
      })

      return [...entry('assistant', 'assistant', textFromContent(message.content)), ...toolCalls]
    }
    case 'toolResult': {
      const name = typeof message.toolName === 'string' ? message.toolName : 'unknown'
      const interaction = userInteractionText(message, interactionCalls)
      if (interaction !== undefined) {
        return [{ index, kind: 'user_interaction', label: `user_interaction:${name}`, text: interaction }]
      }

      return entry(
        'tool',
        `tool:${name}${message.isError === true ? ' (error)' : ''}`,
        textFromContent(message.content),
      )
    }
    case 'bashExecution':
      return [
        {
          index,
          kind: 'tool',
          label: 'tool:user-bash',
          text: `${serializeUnknown(message.command)}\n${serializeUnknown(message.output)}`,
        },
      ]
    case 'branchSummary':
    case 'compactionSummary':
      return entry('assistant', message.role, serializeUnknown(message.summary))
    case 'custom':
      return entry('assistant', 'custom', textFromContent(message.content))
    default:
      return []
  }
}

function collectEntries(sessionEntries: SessionEntry[]): TranscriptEntry[] {
  const interactionCalls = new Map<string, string>()

  return sessionEntries.flatMap((entry, index): TranscriptEntry[] => {
    if (entry.type === 'message') {
      return entriesFromMessage(entry.message, index, interactionCalls)
    }
    if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      return [{ index, kind: 'assistant', label: entry.type, text: entry.summary }]
    }
    if (entry.type === 'custom_message') {
      const text = textFromContent(entry.content)

      return text ? [{ index, kind: 'assistant', label: 'custom', text }] : []
    }

    return []
  })
}

/** The complete arguments of the assistant tool call that raised an ask, which the ask itself only previews. */
export function findToolCallInput(sessionEntries: SessionEntry[], toolCallId: string | undefined): unknown {
  if (toolCallId === undefined) {
    return undefined
  }
  const inputs = sessionEntries.flatMap(entry => {
    const message: MessageLike = entry.type === 'message' ? entry.message : {}

    return (message.role === 'assistant' && Array.isArray(message.content) ? message.content : []).flatMap(
      (block: ContentBlock) => (block.type === 'toolCall' && block.id === toolCallId ? [block.arguments] : []),
    )
  })

  return inputs.at(-1)
}

function renderEntry(entry: TranscriptEntry): string {
  return JSON.stringify({ index: entry.index, source: entry.kind, label: entry.label, content: entry.text })
}

function pool(entry: TranscriptEntry): 'message' | 'tool' {
  return entry.kind === 'tool' ? 'tool' : 'message'
}

/** Truncates after JSON escaping, which can multiply the rendered length, so the cap holds on the wire. */
function pretruncate(entry: TranscriptEntry): TranscriptEntry {
  const maxCharacters = ENTRY_TOKENS[pool(entry)] * 4
  if (renderEntry(entry).length <= maxCharacters) {
    return entry
  }

  let lower = 0
  let upper = Math.min(entry.text.length, maxCharacters)
  let text = truncateToCharacters(entry.text, 0)
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2)
    const candidate = truncateToCharacters(entry.text, middle)
    if (renderEntry({ ...entry, text: candidate }).length <= maxCharacters) {
      text = candidate
      lower = middle + 1
    } else {
      upper = middle - 1
    }
  }

  return { ...entry, text, truncated: true }
}

function isTrusted(entry: TranscriptEntry): boolean {
  return entry.kind === 'user' || entry.kind === 'user_interaction'
}

/**
 * Keeps the first and latest trusted records unconditionally, then other trusted records newest first, then the
 * newest untrusted ones; the untrusted cap never evicts an authorization that was already selected.
 */
export function renderTranscript(sessionEntries: SessionEntry[]): RenderedTranscript {
  const all = collectEntries(sessionEntries).map(pretruncate)
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
