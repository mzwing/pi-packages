import type { AssistantMessage, TranscriptContext } from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt } from '@earendil-works/pi-ai'

function callTool(name: string, args: Record<string, unknown>): AssistantMessage {
  return fauxAssistantMessage(fauxToolCall(name, args as never), { stopReason: 'toolUse' })
}

function prompted(context: TranscriptContext): string {
  const first = context.messages.find(message => message.role === 'user')
  const content = first?.role === 'user' ? first.content : ''

  return typeof content === 'string'
    ? content
    : content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('')
}

/**
 * Plays each governed role through one task that adds a.txt, choosing its next step from the tools it already ran. The
 * first executor session develops and hands off; the one taking over reviews
 */
function respond(context: TranscriptContext): AssistantMessage {
  const system = getCurrentSystemPrompt(context.messages)
  const ran = new Set(context.messages.flatMap(message => (message.role === 'toolResult' ? [message.toolName] : [])))
  if (system.includes('You are the executor')) {
    if (prompted(context).startsWith('Continue this task')) {
      return ran.has('task_review')
        ? fauxAssistantMessage('The task waits for its sign-off.')
        : callTool('task_review', {})
    }
    if (!ran.has('task_develop')) {
      return callTool('task_develop', { instructions: 'Create a.txt containing hello' })
    }

    return ran.has('task_handoff')
      ? fauxAssistantMessage('Handed off.')
      : callTool('task_handoff', { note: 'a.txt is written; it needs its review.' })
  }
  if (system.includes('You are the developer')) {
    return ran.has('write')
      ? fauxAssistantMessage('Created a.txt containing hello.')
      : callTool('write', { path: 'a.txt', content: 'hello\n' })
  }
  if (system.includes('You are the reviewer')) {
    if (!ran.has('task_check')) {
      return callTool('task_check', { criterion: 'A1' })
    }

    return ran.has('task_verdict')
      ? fauxAssistantMessage('Signed off.')
      : callTool('task_verdict', {
          verdict: 'pass',
          observations: [{ criterion: 'A2', text: 'a.txt line 1 reads hello' }],
        })
  }

  return fauxAssistantMessage('Nothing to do.')
}

export default function fauxModel(pi: ExtensionAPI): void {
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-1' }] })
  faux.setResponses(Array.from<typeof respond>({ length: 100 }).fill(respond))
  pi.registerProvider(faux.provider)
}
