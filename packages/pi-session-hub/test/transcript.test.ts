import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readTranscript } from '../src/transcript.js'

const ENTRIES = [
  { type: 'session', version: 3, id: 'abc', timestamp: '2026-10-06T00:00:00.000Z', cwd: '/project' },
  { type: 'model_change', id: 'e0', parentId: null, timestamp: '', provider: 'faux', modelId: 'faux-1' },
  {
    type: 'message',
    id: 'e1',
    parentId: 'e0',
    timestamp: '',
    message: { role: 'user', content: 'Fix the parser', timestamp: 1 },
  },
  {
    type: 'message',
    id: 'e2',
    parentId: 'e1',
    timestamp: '',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hidden' },
        { type: 'text', text: 'Reading it first.' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'src/parser.ts' } },
      ],
      timestamp: 2,
    },
  },
  {
    type: 'message',
    id: 'e3',
    parentId: 'e2',
    timestamp: '',
    message: {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'read',
      content: [{ type: 'text', text: 'export function parse() {}' }],
      isError: false,
      timestamp: 3,
    },
  },
  {
    type: 'custom_message',
    id: 'e4',
    parentId: 'e3',
    timestamp: '',
    customType: 'session-hub:message',
    content: 'Message from session "boss"',
    display: true,
  },
]

describe('transcript', () => {
  let root = ''
  let file = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pi-session-hub-'))
    file = join(root, 'session.jsonl')
    writeFileSync(file, `${ENTRIES.map(entry => JSON.stringify(entry)).join('\n')}\n{"type":"mess`)
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('renders text and tool calls, skips thinking, tool results and a half-written line', () => {
    expect(readTranscript(file, { last: 20, tools: false })).toBe(
      [
        'user: Fix the parser',
        'assistant: Reading it first.\n→ read({"path":"src/parser.ts"})',
        '[session-hub:message] Message from session "boss"',
      ].join('\n\n'),
    )
  })

  it('includes tool results on request and keeps only the newest items', () => {
    expect(readTranscript(file, { last: 2, tools: true })).toBe(
      ['read result: export function parse() {}', '[session-hub:message] Message from session "boss"'].join('\n\n'),
    )
  })
})
