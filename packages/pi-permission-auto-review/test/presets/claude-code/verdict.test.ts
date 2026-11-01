import { expect, it } from 'vitest'
import { parseFastVerdict, parseVerdict } from '../../../src/presets/claude-code/verdict.js'

// Claude Code's stop sequence cuts its fast pass at the first `</block>`, so only the opening counts
it('judges the fast pass by its opening tag, and sends a reply that opens any other way on', () => {
  expect(parseFastVerdict(' <block>no\n')).toBe('allow')
  expect(parseFastVerdict('<block>no</block> since the file is local')).toBe('allow')
  expect(parseFastVerdict('<block>yes</block>')).toBe('block')
  expect(parseFastVerdict('<')).toBe('unparseable')
  expect(parseFastVerdict('Looking at the action: <block>no</block>')).toBe('unparseable')
  expect(parseFastVerdict('<block>nope</block>')).toBe('unparseable')
})

it('reads the second pass after its reasoning, and refuses a verdict that is missing or contradicts itself', () => {
  expect(parseVerdict('<thinking>Is it <block>yes</block>?</thinking><block>no</block>')).toEqual({ outcome: 'allow' })
  expect(
    parseVerdict(
      '<thinking>…</thinking><block>yes</block><category>Production Deploy</category><reason>[Production Deploy] Ships to prod.</reason>',
    ),
  ).toEqual({ outcome: 'deny', category: 'Production Deploy', reason: '[Production Deploy] Ships to prod.' })
  expect(parseVerdict('<block>yes</block><reason>[Git Destructive] Rewrites main.</reason>')).toEqual({
    outcome: 'deny',
    category: 'Git Destructive',
    reason: '[Git Destructive] Rewrites main.',
  })
  expect(() => parseVerdict('<thinking>Still weighing <block>no')).toThrow()
  expect(() => parseVerdict('<block>yes</block> or rather <block>no</block>')).toThrow()
})
