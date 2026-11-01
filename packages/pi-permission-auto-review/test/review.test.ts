import { expect, it } from 'vitest'
import * as review from '../src/review.js'

it('exports exactly the documented pipeline from the ./review subpath', () => {
  expect(Object.keys(review).toSorted()).toEqual([
    'CLAUDE_CODE_POLICY_REVISION',
    'CLAUDE_CODE_THINKING_PROMPT',
    'DEFAULT_CONFIG',
    'FIXED_REVIEW_PROTOCOL',
    'POLICY_REVISION',
    'buildClaudeCodeReviewMessage',
    'buildClaudeCodeSystemPrompt',
    'buildReviewPrompt',
    'buildSystemPrompt',
    'findToolCallInput',
    'parseClaudeCodeFastVerdict',
    'parseClaudeCodeVerdict',
    'parseReviewAssessment',
    'renderClaudeCodeTranscript',
    'renderTranscript',
  ])
})
