import type { ImageContent, TextContent } from '@earendil-works/pi-ai'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { readFileSync } from 'node:fs'
import { buildContextEntries, parseSessionEntries } from '@earendil-works/pi-coding-agent'

type AgentMessage = Extract<SessionEntry, { type: 'message' }>['message']

export interface TranscriptOptions {
  /** How many items to keep, counting back from the newest. */
  last: number
  /** Include tool results, which are long and usually not what a reader is after. */
  tools: boolean
}

const TEXT_LIMIT = 2_000
const ARGUMENTS_LIMIT = 200

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function textOf(content: string | (TextContent | ImageContent)[]): string {
  return typeof content === 'string'
    ? content
    : content.flatMap(block => (block.type === 'text' ? [block.text] : ['[image]'])).join('\n')
}

function renderMessage(message: AgentMessage, tools: boolean): string[] {
  switch (message.role) {
    case 'user':
      return [`user: ${clip(textOf(message.content), TEXT_LIMIT)}`]
    case 'assistant': {
      const parts = message.content.flatMap(block => {
        if (block.type === 'text') {
          return [clip(block.text, TEXT_LIMIT)]
        }

        return block.type === 'toolCall'
          ? [`→ ${block.name}(${clip(JSON.stringify(block.arguments), ARGUMENTS_LIMIT)})`]
          : []
      })

      return parts.length === 0 ? [] : [`assistant: ${parts.join('\n')}`]
    }
    case 'toolResult':
      return tools
        ? [`${message.toolName} ${message.isError ? 'error' : 'result'}: ${clip(textOf(message.content), TEXT_LIMIT)}`]
        : []
    case 'bashExecution':
      return [`user ran: ${message.command}`]
    case 'system':
    case 'custom':
    case 'branchSummary':
    case 'compactionSummary':
    default:
      return []
  }
}

function renderEntry(entry: SessionEntry, tools: boolean): string[] {
  switch (entry.type) {
    case 'message':
      return renderMessage(entry.message, tools)
    case 'custom_message':
      return [`[${entry.customType}] ${clip(textOf(entry.content), TEXT_LIMIT)}`]
    case 'compaction':
      return [`[compaction summary] ${clip(entry.summary, TEXT_LIMIT)}`]
    case 'branch_summary':
      return [`[branch summary] ${clip(entry.summary, TEXT_LIMIT)}`]
    case 'thinking_level_change':
    case 'model_change':
    case 'usage':
    case 'custom':
    case 'context_edit':
    case 'label':
    case 'session_info':
    default:
      return []
  }
}

/** The active branch as the session's model sees it, so a compacted past shows as its summary. */
export function readTranscript(file: string, options: TranscriptOptions): string {
  const entries = parseSessionEntries(readFileSync(file, 'utf8')).filter(
    (entry): entry is SessionEntry => entry.type !== 'session',
  )

  return buildContextEntries(entries)
    .flatMap(entry => renderEntry(entry, options.tools))
    .slice(-options.last)
    .join('\n\n')
}
