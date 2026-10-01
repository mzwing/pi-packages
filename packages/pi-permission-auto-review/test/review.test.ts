import { expect, it } from 'vitest'
import * as review from '../src/review.js'

it('exports exactly the documented pipeline from the ./review subpath', () => {
  expect(Object.keys(review).toSorted()).toEqual([
    'DEFAULT_CONFIG',
    'FIXED_REVIEW_PROTOCOL',
    'POLICY_REVISION',
    'buildReviewPrompt',
    'buildSystemPrompt',
    'parseReviewAssessment',
    'renderTranscript',
  ])
})
