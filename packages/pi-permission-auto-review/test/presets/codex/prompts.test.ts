import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../../src/config/config.js'
import { buildSystemPrompt } from '../../../src/presets/codex/policy.js'
import { buildFollowUpPrompt, buildReviewPrompt } from '../../../src/presets/codex/review-prompt.js'
import { renderTranscript } from '../../../src/presets/codex/transcript.js'
import { findToolCallInput } from '../../../src/presets/session.js'
import { permissionDetails } from '../../helpers.js'

function messageEntry(id: string, message: Record<string, unknown>): SessionEntry {
  return { type: 'message', id, parentId: null, timestamp: '2026-07-23T00:00:00.000Z', message } as SessionEntry
}

const BRANCH = [
  messageEntry('ask', { role: 'user', content: 'Publish the package, then push its tag.', timestamp: 0 }),
  messageEntry('publish', {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Publishing first.' },
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pnpm publish' } },
    ],
    timestamp: 0,
  }),
  messageEntry('published', {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'bash',
    content: [{ type: 'text', text: '+ @scope/pkg@1.0.0' }],
    isError: false,
    timestamp: 0,
  }),
  messageEntry('push', {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'call-2', name: 'bash', arguments: { command: 'git push --tags' } }],
    timestamp: 0,
  }),
]
const DETAILS = permissionDetails({ toolCallId: 'call-2', command: 'git push --tags' })

// The text codex-auto-review reads, pinned so that only a deliberate port changes it
it('keeps the default system prompt as reconciled against upstream', async () => {
  await expect(buildSystemPrompt(DEFAULT_CONFIG)).toMatchFileSnapshot('./__snapshots__/system-prompt.txt')
})

it('keeps the full and follow-up review prompts', async () => {
  const toolInput = findToolCallInput(BRANCH, DETAILS.toolCallId)

  await expect(
    buildReviewPrompt(DEFAULT_CONFIG, renderTranscript(BRANCH), DETAILS, toolInput).userPrompt,
  ).toMatchFileSnapshot('./__snapshots__/review-prompt.txt')
  await expect(buildFollowUpPrompt(renderTranscript(BRANCH, 2), DETAILS, toolInput)).toMatchFileSnapshot(
    './__snapshots__/follow-up-prompt.txt',
  )
})
