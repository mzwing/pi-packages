import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { serializeUnknown } from '../text.js'

const TRUSTED_USER_INTERACTION_TOOLS = new Set(['ask_user_question', 'plan_mode_question'])

/** The entry type or message role a summary or an extension's message came as */
type NoteLabel = 'compaction' | 'compactionSummary' | 'branch_summary' | 'branchSummary' | 'custom'

/** One piece of a session branch, in branch order; `index` is the position of its entry in the branch */
export type SessionEvent =
  | { kind: 'user'; index: number; text: string }
  | { kind: 'assistant'; index: number; text: string }
  | { kind: 'toolCall'; index: number; position: number; id: string | undefined; name: string; input: unknown }
  | { kind: 'toolResult'; index: number; toolCallId: string | undefined; name: string; text: string; isError: boolean }
  | { kind: 'interaction'; index: number; name: string; answers: UserAnswer[] }
  | { kind: 'userBash'; index: number; command: string; output: string; excluded: boolean }
  | { kind: 'note'; index: number; label: NoteLabel; text: string }

// Persisted session data, so every field is decoded rather than trusted to match the current types
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
  excludeFromContext?: unknown
}

interface UserAnswer {
  question: string
  answer: unknown
}

interface UserInteractionAnswer {
  question?: unknown
  answer?: unknown
  selected?: unknown
  notes?: unknown
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
 * its structured details so free-form tool text is never promoted to user evidence
 */
function userAnswers(message: MessageLike, interactionCalls: ReadonlyMap<string, string>): UserAnswer[] | undefined {
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

  const evidence: UserAnswer[] = []
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

  return evidence
}

function note(index: number, label: NoteLabel, text: string): SessionEvent[] {
  return text ? [{ kind: 'note', index, label, text }] : []
}

function eventsFromMessage(message: MessageLike, index: number, interactionCalls: Map<string, string>): SessionEvent[] {
  switch (message.role) {
    case 'user': {
      const text = textFromContent(message.content)

      return text ? [{ kind: 'user', index, text }] : []
    }
    case 'assistant': {
      const text = textFromContent(message.content)
      const calls = (Array.isArray(message.content) ? message.content : [])
        .filter((block: ContentBlock) => block.type === 'toolCall')
        .map((block: ContentBlock, position): SessionEvent => {
          const id = typeof block.id === 'string' ? block.id : undefined
          const name =
            typeof block.name === 'string'
              ? block.name
              : typeof block.toolName === 'string'
                ? block.toolName
                : 'unknown'
          if (id !== undefined && TRUSTED_USER_INTERACTION_TOOLS.has(name)) {
            interactionCalls.set(id, name)
          }

          return { kind: 'toolCall', index, position, id, name, input: block.arguments }
        })

      return [...(text ? [{ kind: 'assistant' as const, index, text }] : []), ...calls]
    }
    case 'toolResult': {
      const name = typeof message.toolName === 'string' ? message.toolName : 'unknown'
      const answers = userAnswers(message, interactionCalls)
      if (answers !== undefined) {
        return [{ kind: 'interaction', index, name, answers }]
      }

      return [
        {
          kind: 'toolResult',
          index,
          toolCallId: typeof message.toolCallId === 'string' ? message.toolCallId : undefined,
          name,
          text: textFromContent(message.content),
          isError: message.isError === true,
        },
      ]
    }
    case 'bashExecution':
      return [
        {
          kind: 'userBash',
          index,
          command: serializeUnknown(message.command),
          output: serializeUnknown(message.output),
          excluded: message.excludeFromContext === true,
        },
      ]
    case 'branchSummary':
      return note(index, 'branchSummary', serializeUnknown(message.summary))
    case 'compactionSummary':
      return note(index, 'compactionSummary', serializeUnknown(message.summary))
    case 'custom':
      return note(index, 'custom', textFromContent(message.content))
    default:
      return []
  }
}

export function decodeSession(entries: SessionEntry[]): SessionEvent[] {
  const interactionCalls = new Map<string, string>()

  return entries.flatMap((entry, index): SessionEvent[] => {
    if (entry.type === 'message') {
      return eventsFromMessage(entry.message, index, interactionCalls)
    }
    if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      return [{ kind: 'note', index, label: entry.type, text: entry.summary }]
    }

    return entry.type === 'custom_message' ? note(index, 'custom', textFromContent(entry.content)) : []
  })
}

/** The complete arguments of the assistant tool call that raised an ask, which the ask itself only previews */
export function findToolCallInput(entries: SessionEntry[], toolCallId: string | undefined): unknown {
  if (toolCallId === undefined) {
    return undefined
  }
  const inputs = entries.flatMap(entry => {
    const message: MessageLike = entry.type === 'message' ? entry.message : {}

    return (message.role === 'assistant' && Array.isArray(message.content) ? message.content : []).flatMap(
      (block: ContentBlock) => (block.type === 'toolCall' && block.id === toolCallId ? [block.arguments] : []),
    )
  })

  return inputs.at(-1)
}
