import { describe, expect, it } from 'vitest'
import { parseReviewAssessment } from '../src/verdict.js'

describe('parseReviewAssessment', () => {
  it('accepts the compact Codex allow response', () => {
    expect(parseReviewAssessment('{"outcome":"allow"}')).toEqual({
      riskLevel: 'low',
      userAuthorization: 'unknown',
      outcome: 'allow',
      rationale: 'Automatic review returned a low-risk allow decision.',
    })
  })

  it('accepts a single JSON object surrounded by model text', () => {
    expect(
      parseReviewAssessment(
        'Result:\n{"risk_level":"high","user_authorization":"low","outcome":"deny","rationale":"The target is not authorized."}\n',
      ),
    ).toMatchObject({
      riskLevel: 'high',
      userAuthorization: 'low',
      outcome: 'deny',
    })
  })

  it('rejects invalid, ambiguous, or extended payloads', () => {
    expect(() => parseReviewAssessment('not json')).toThrow()
    expect(() => parseReviewAssessment('{"outcome":"allow"} then {"outcome":"deny"}')).toThrow()
    expect(() => parseReviewAssessment('{"outcome":"allow","extra":true}')).toThrow()
  })
})
