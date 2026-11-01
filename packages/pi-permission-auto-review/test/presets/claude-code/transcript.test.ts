import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { expect, it } from 'vitest'
import { renderTranscript } from '../../../src/presets/claude-code/transcript.js'
import { permissionDetails } from '../../helpers.js'

function entry(id: string, message: Record<string, unknown>): SessionEntry {
  return { type: 'message', id, parentId: null, timestamp: '2026-07-23T00:00:00.000Z', message } as SessionEntry
}

function user(id: string, text: string): SessionEntry {
  return entry(id, { role: 'user', content: text, timestamp: 0 })
}

function assistant(id: string, text: string, calls: [string, string, Record<string, unknown>][] = []): SessionEntry {
  return entry(id, {
    role: 'assistant',
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      ...calls.map(([callId, name, input]) => ({ type: 'toolCall', id: callId, name, arguments: input })),
    ],
    timestamp: 0,
  })
}

function result(id: string, callId: string, name: string, text: string, isError = false): SessionEntry {
  return entry(id, {
    role: 'toolResult',
    toolCallId: callId,
    toolName: name,
    content: [{ type: 'text', text }],
    isError,
    timestamp: 0,
  })
}

function lines(entries: SessionEntry[], toolCallId?: string, after?: { entryId: string; toolCallId?: string }) {
  return renderTranscript(entries, permissionDetails(toolCallId === undefined ? {} : { toolCallId }), after).lines
}

it('shows user lines with the prose they answer, calls with their outcomes, and the action last', () => {
  const branch = [
    user('u1', 'Tidy the repo.'),
    assistant('a1', 'Checking the status first.', [
      ['c1', 'bash', { command: 'git status' }],
      ['c2', 'read', { path: 'README.md' }],
    ]),
    result('r1', 'c1', 'bash', 'On branch main'),
    result('r2', 'c2', 'read', 'the readme text'),
    assistant('a2', 'Shall I force-push main to drop the merge commit?'),
    user('u2', 'yes'),
    assistant('a3', 'Force-pushing now.', [
      ['c3', 'bash', { command: 'git push --force origin main' }],
      ['c4', 'bash', { command: 'git push --tags' }],
    ]),
  ]

  expect(lines(branch, 'c3')).toEqual([
    '{"user":"Tidy the repo."}',
    '{"bash":{"command":"git status"},"id":"1.0"}',
    '{"outcome":"ok","id":"1.0"}',
    '{"assistant":"Shall I force-push main to drop the merge commit?"}',
    '{"user":"yes"}',
    '{"bash":{"command":"git push --force origin main"},"id":"6.0"}',
  ])
})

it('tells failed and interrupted calls apart, and leaves a sibling still waiting to run without an outcome', () => {
  const branch = [
    assistant('a1', '', [['c1', 'bash', { command: 'pnpm test' }]]),
    result('r1', 'c1', 'bash', 'Operation aborted', true),
    assistant('a2', '', [['c2', 'bash', { command: 'pnpm lint' }]]),
    result('r2', 'c2', 'bash', 'lint failed', true),
    assistant('a3', '', [
      ['c3', 'bash', { command: 'pnpm build' }],
      ['c4', 'bash', { command: 'pnpm publish' }],
    ]),
  ]

  expect(lines(branch, 'c4')).toEqual([
    '{"bash":{"command":"pnpm test"},"id":"0.0"}',
    '{"outcome":"interrupted","id":"0.0"}',
    '{"bash":{"command":"pnpm lint"},"id":"2.0"}',
    '{"outcome":"error","id":"2.0"}',
    '{"bash":{"command":"pnpm build"},"id":"4.0"}',
    '{"bash":{"command":"pnpm publish"},"id":"4.1"}',
  ])
})

it('keeps every voice but the user under its own key, and shows the request when no call raised the ask', () => {
  const branch = [
    assistant('ask', '', [['q1', 'ask_user_question', { questions: [{ question: 'Push now?' }] }]]),
    entry('answer', {
      role: 'toolResult',
      toolCallId: 'q1',
      toolName: 'ask_user_question',
      content: [{ type: 'text', text: 'free-form text is never trusted' }],
      details: { cancelled: false, answers: [{ question: 'Push now?', answer: 'Yes' }] },
      isError: false,
      timestamp: 0,
    }),
    { type: 'custom_message', id: 'mail', parentId: null, timestamp: '', content: 'Mail from another session' },
    { type: 'compaction', id: 'compacted', parentId: null, timestamp: '', summary: 'Earlier work' },
    entry('shell', { role: 'bashExecution', command: 'git log', output: 'commit 1', timestamp: 0 }),
    entry('quiet', {
      role: 'bashExecution',
      command: 'cat .env',
      output: 'TOKEN=1',
      excludeFromContext: true,
      timestamp: 0,
    }),
  ] as SessionEntry[]
  const rendered = lines(branch)

  expect(rendered.slice(0, -1)).toEqual([
    '{"ask_user_question":{"questions":[{"question":"Push now?"}]},"id":"0.0"}',
    '{"user_answer":[{"question":"Push now?","answer":"Yes"}]}',
    '{"custom_message":"Mail from another session"}',
    '{"compaction_summary":"Earlier work"}',
    '{"user_bash":"git log"}',
  ])
  expect(rendered.at(-1)).toMatch(/^\{"permission_request":\{"requestId":"request-1"/)
})

// A terse reply often answers a proposal the previous review already saw
it('continues after a cursor, bringing along the proposal that a later reply answers', () => {
  const branch = [
    user('u1', 'Run the tests.'),
    assistant('a1', 'Shall I delete build/ once the tests pass?', [['c1', 'bash', { command: 'pnpm test' }]]),
    result('r1', 'c1', 'bash', 'all passed'),
    user('u2', 'yes'),
    assistant('a2', '', [['c2', 'bash', { command: 'rm -rf build' }]]),
  ]

  expect(lines(branch, 'c2', { entryId: 'a1', toolCallId: 'c1' })).toEqual([
    '{"outcome":"ok","id":"1.0"}',
    '{"assistant":"Shall I delete build/ once the tests pass?"}',
    '{"user":"yes"}',
    '{"bash":{"command":"rm -rf build"},"id":"4.0"}',
  ])
})

it('drops the oldest calls before any user line when the transcript runs long, and marks the gap', () => {
  const calls = Array.from({ length: 30 }, (_, index) =>
    assistant(`a${index}`, '', [[`c${index}`, 'bash', { command: `echo ${String(index).repeat(5_000)}` }]]),
  )
  const branch = [
    user('first', 'Start.'),
    ...calls,
    user('latest', 'Go on.'),
    assistant('act', '', [['act', 'bash', { command: 'ls -la' }]]),
  ]
  const rendered = renderTranscript(branch, permissionDetails({ toolCallId: 'act' }))

  expect(rendered.lines[0]).toBe('{"user":"Start."}')
  expect(rendered.lines[1]).toMatch(/^\{"omitted":[1-9]\d*\}$/)
  expect(rendered.lines.at(-2)).toBe('{"user":"Go on."}')
  expect(rendered.lines.at(-1)).toBe('{"bash":{"command":"ls -la"},"id":"32.0"}')
  expect(rendered.stats.transcriptLinesOmitted).toBeGreaterThan(0)
})
