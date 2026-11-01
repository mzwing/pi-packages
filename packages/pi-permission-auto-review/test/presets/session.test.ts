import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { expect, it } from 'vitest'
import { findToolCallInput } from '../../src/presets/session.js'

function messageEntry(id: string, role: string, content: unknown): SessionEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-07-23T00:00:00.000Z',
    message: { role, content, timestamp: 0 },
  } as SessionEntry
}

it('finds the complete arguments of the call with that id, and nothing for an ask without one', () => {
  const input = { path: 'notes.md', content: 'x'.repeat(50_000) }
  const entries = [
    messageEntry('user', 'user', 'Write the notes.'),
    messageEntry('assistant', 'assistant', [
      { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } },
      { type: 'toolCall', id: 'call-1', name: 'write', arguments: input },
    ]),
  ]

  expect(findToolCallInput(entries, 'call-1')).toEqual(input)
  expect(findToolCallInput(entries, 'call-2')).toBeUndefined()
  expect(findToolCallInput(entries, undefined)).toBeUndefined()
})
