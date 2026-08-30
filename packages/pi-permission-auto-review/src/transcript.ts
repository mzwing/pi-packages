import type { SessionEntry } from '@earendil-works/pi-coding-agent'

const MAX_RECENT_UNTRUSTED_ENTRIES = 40
const MAX_MESSAGE_TRANSCRIPT_TOKENS = 10_000
const MAX_TOOL_TRANSCRIPT_TOKENS = 10_000
const MAX_MESSAGE_ENTRY_TOKENS = 2_000
const MAX_TOOL_ENTRY_TOKENS = 1_000
const TRUSTED_USER_INTERACTION_TOOLS = new Set(['ask_user_question', 'plan_mode_question'])

type TranscriptKind = 'user' | 'user_interaction' | 'assistant' | 'tool'

export interface TranscriptEntry {
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

interface ContentBlock {
  type?: unknown
  id?: unknown
  text?: unknown
  thinking?: unknown
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

interface UserInteractionDetails {
  cancelled?: unknown
  answers?: unknown
}

interface UserInteractionAnswer {
  question?: unknown
  answer?: unknown
  selected?: unknown
  notes?: unknown
}

function approximateTokens(text: string): number {
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
  // `slice(-0)` is `slice(0)`, which would return the whole string when the budget leaves no tail.
  return `${text.slice(0, headLength)}${tag}${text.slice(text.length - tailLength)}`
}

export function truncateToApproximateTokens(text: string, maxTokens: number): string {
  return truncateToCharacters(text, maxTokens * 4)
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
  if (Array.isArray(value)) {
    return value.map(normalizeAnswer)
  }
  return serializeUnknown(value)
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return serializeUnknown(content)
  }
  return content
    .map(rawBlock => {
      const block = rawBlock as ContentBlock
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text
      }
      if (block.type === 'image') {
        return '[image omitted]'
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function normalizedAnswerEvidence(answer: UserInteractionAnswer): unknown | undefined {
  const primaryAnswer =
    answer.answer !== undefined && answer.answer !== null
      ? normalizeAnswer(answer.answer)
      : Array.isArray(answer.selected) && answer.selected.length > 0
        ? answer.selected.map(normalizeAnswer)
        : undefined
  const notes = typeof answer.notes === 'string' && answer.notes.length > 0 ? answer.notes : undefined
  if (primaryAnswer === undefined) {
    return notes
  }
  if (notes === undefined) {
    return primaryAnswer
  }
  return { selection: primaryAnswer, notes }
}

function normalizedUserInteraction(
  message: MessageLike,
  interactionToolCalls: ReadonlyMap<string, string>,
): TranscriptEntry['text'] | undefined {
  const name = typeof message.toolName === 'string' ? message.toolName : undefined
  const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined
  if (
    name === undefined ||
    toolCallId === undefined ||
    !TRUSTED_USER_INTERACTION_TOOLS.has(name) ||
    interactionToolCalls.get(toolCallId) !== name ||
    message.isError !== false
  ) {
    return undefined
  }
  if (message.details === null || typeof message.details !== 'object') {
    return undefined
  }

  const details = message.details as UserInteractionDetails
  if (details.cancelled !== false || !Array.isArray(details.answers) || details.answers.length === 0) {
    return undefined
  }

  const answers: Array<{ question: string; answer: unknown }> = []
  for (const rawAnswer of details.answers) {
    if (rawAnswer === null || typeof rawAnswer !== 'object') {
      return undefined
    }
    const answer = rawAnswer as UserInteractionAnswer
    const answerEvidence = normalizedAnswerEvidence(answer)
    if (typeof answer.question !== 'string' || answer.question.length === 0 || answerEvidence === undefined) {
      return undefined
    }
    answers.push({
      question: answer.question,
      answer: answerEvidence,
    })
  }
  return JSON.stringify(answers)
}

function assistantEntries(
  message: MessageLike,
  index: number,
  interactionToolCalls: Map<string, string>,
): TranscriptEntry[] {
  const content = Array.isArray(message.content) ? message.content : []
  const text = textFromContent(message.content)
  const entries: TranscriptEntry[] = []
  if (text) {
    entries.push({ index, kind: 'assistant', label: 'assistant', text })
  }
  for (const rawBlock of content) {
    const block = rawBlock as ContentBlock
    if (block.type !== 'toolCall') {
      continue
    }
    const name =
      typeof block.name === 'string' ? block.name : typeof block.toolName === 'string' ? block.toolName : 'unknown'
    if (typeof block.id === 'string' && TRUSTED_USER_INTERACTION_TOOLS.has(name)) {
      interactionToolCalls.set(block.id, name)
    }
    entries.push({
      index,
      kind: 'tool',
      label: `tool:${name}`,
      text: serializeUnknown(block.arguments),
    })
  }
  return entries
}

function entriesFromMessage(
  message: MessageLike,
  index: number,
  interactionToolCalls: Map<string, string>,
): TranscriptEntry[] {
  switch (message.role) {
    case 'user': {
      const text = textFromContent(message.content)
      return text ? [{ index, kind: 'user', label: 'user', text }] : []
    }
    case 'assistant':
      return assistantEntries(message, index, interactionToolCalls)
    case 'toolResult': {
      const name = typeof message.toolName === 'string' ? message.toolName : 'unknown'
      const userInteraction = normalizedUserInteraction(message, interactionToolCalls)
      if (userInteraction !== undefined) {
        return [
          {
            index,
            kind: 'user_interaction',
            label: `user_interaction:${name}`,
            text: userInteraction,
          },
        ]
      }
      const suffix = message.isError === true ? ' (error)' : ''
      const text = textFromContent(message.content)
      return text ? [{ index, kind: 'tool', label: `tool:${name}${suffix}`, text }] : []
    }
    case 'bashExecution': {
      const command = serializeUnknown(message.command)
      const output = serializeUnknown(message.output)
      return [
        {
          index,
          kind: 'tool',
          label: 'tool:user-bash',
          text: `${command}\n${output}`,
        },
      ]
    }
    case 'branchSummary':
    case 'compactionSummary': {
      const text = serializeUnknown(message.summary)
      return text ? [{ index, kind: 'assistant', label: String(message.role), text }] : []
    }
    case 'custom': {
      const text = textFromContent(message.content)
      return text ? [{ index, kind: 'assistant', label: 'custom', text }] : []
    }
    default:
      return []
  }
}

export function collectTranscriptEntries(sessionEntries: SessionEntry[]): TranscriptEntry[] {
  const interactionToolCalls = new Map<string, string>()
  return sessionEntries.flatMap((entry, index) => {
    if (entry.type === 'message') {
      return entriesFromMessage(entry.message as MessageLike, index, interactionToolCalls)
    }
    if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      return [
        {
          index,
          kind: 'assistant' as const,
          label: entry.type,
          text: entry.summary,
        },
      ]
    }
    if (entry.type === 'custom_message') {
      const text = textFromContent(entry.content)
      return text
        ? [
            {
              index,
              kind: 'assistant' as const,
              label: 'custom',
              text,
            },
          ]
        : []
    }
    return []
  })
}

function renderTranscriptEntry(entry: TranscriptEntry): string {
  return JSON.stringify({
    index: entry.index,
    source: entry.kind,
    label: entry.label,
    content: entry.text,
  })
}

function transcriptEntryTokens(entry: TranscriptEntry): number {
  return approximateTokens(renderTranscriptEntry(entry))
}

function pretruncate(entry: TranscriptEntry): TranscriptEntry {
  const maxTokens = entry.kind === 'tool' ? MAX_TOOL_ENTRY_TOKENS : MAX_MESSAGE_ENTRY_TOKENS
  const maxCharacters = maxTokens * 4
  if (renderTranscriptEntry(entry).length <= maxCharacters) {
    return entry
  }

  let lower = 0
  let upper = Math.min(entry.text.length, maxCharacters)
  let text = truncateToCharacters(entry.text, 0)
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2)
    const candidate = truncateToCharacters(entry.text, middle)
    if (renderTranscriptEntry({ ...entry, text: candidate }).length <= maxCharacters) {
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

function addWithinBudget(selected: Set<TranscriptEntry>, entries: TranscriptEntry[], budget: number): number {
  let used = 0
  for (const entry of entries) {
    const tokens = transcriptEntryTokens(entry)
    if (used + tokens > budget) {
      continue
    }
    selected.add(entry)
    used += tokens
  }
  return used
}

export function renderTranscript(sessionEntries: SessionEntry[]): RenderedTranscript {
  const allEntries = collectTranscriptEntries(sessionEntries).map(pretruncate)
  const selected = new Set<TranscriptEntry>()
  const trustedEntries = allEntries.filter(isTrusted)

  let messageTokens = 0
  if (trustedEntries.length > 0) {
    const first = trustedEntries[0]
    const latest = trustedEntries.at(-1)
    if (first !== undefined) {
      selected.add(first)
      messageTokens += transcriptEntryTokens(first)
    }
    if (latest !== undefined && latest !== first) {
      selected.add(latest)
      messageTokens += transcriptEntryTokens(latest)
    }
  }

  const remainingTrusted = trustedEntries.filter(entry => !selected.has(entry)).toReversed()
  messageTokens += addWithinBudget(selected, remainingTrusted, MAX_MESSAGE_TRANSCRIPT_TOKENS - messageTokens)

  let toolTokens = 0
  let untrustedEntriesRetained = 0
  for (const entry of allEntries.toReversed()) {
    if (isTrusted(entry) || untrustedEntriesRetained >= MAX_RECENT_UNTRUSTED_ENTRIES) {
      continue
    }
    const tokens = transcriptEntryTokens(entry)
    if (entry.kind === 'tool') {
      if (toolTokens + tokens > MAX_TOOL_TRANSCRIPT_TOKENS) {
        continue
      }
      toolTokens += tokens
    } else {
      if (messageTokens + tokens > MAX_MESSAGE_TRANSCRIPT_TOKENS) {
        continue
      }
      messageTokens += tokens
    }
    selected.add(entry)
    untrustedEntriesRetained += 1
  }

  const retained = [...selected].sort((left, right) => left.index - right.index)
  const latestTrusted = trustedEntries.at(-1)
  const directUsers = allEntries.filter(entry => entry.kind === 'user')
  const userInteractions = allEntries.filter(entry => entry.kind === 'user_interaction')
  const directUserEntriesRetained = retained.filter(entry => entry.kind === 'user').length
  const userInteractionEntriesRetained = retained.filter(entry => entry.kind === 'user_interaction').length
  const stats: TranscriptStats = {
    transcriptEntriesRetained: retained.length,
    transcriptEntriesOmitted: allEntries.length - retained.length,
    transcriptEntriesTruncated: retained.filter(entry => entry.truncated === true).length,
    directUserEntriesRetained,
    directUserEntriesOmitted: directUsers.length - directUserEntriesRetained,
    directUserEntriesTruncated: retained.filter(entry => entry.kind === 'user' && entry.truncated === true).length,
    userInteractionEntriesRetained,
    userInteractionEntriesOmitted: userInteractions.length - userInteractionEntriesRetained,
    userInteractionEntriesTruncated: retained.filter(
      entry => entry.kind === 'user_interaction' && entry.truncated === true,
    ).length,
    latestTrustedEntryRetained: latestTrusted !== undefined && selected.has(latestTrusted),
  }

  return {
    entries: retained.map(renderTranscriptEntry),
    stats,
  }
}
