import type { PromptPayload, PromptPermissionDetails } from '@gotgenes/pi-permission-system'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import { buildSystemPrompt, POLICY_REVISION } from '../src/policy.js'
import { buildReviewPrompt } from '../src/prompt.js'
import * as review from '../src/review.js'
import { renderTranscript } from '../src/transcript.js'
import { parseReviewAssessment } from '../src/verdict.js'

function promptPayload(): PromptPayload {
  return {
    kind: 'bash',
    request: {
      requester: { agentName: null, forwarded: false, sessionId: null },
      surface: 'bash',
      toolName: 'bash',
      invokedToolName: null,
      value: 'pnpm publish',
      matchedPattern: 'pnpm publish*',
      commandContext: null,
      executedUnit: null,
    },
    evidence: [{ label: 'command', text: 'pnpm publish', detail: null }],
    annotations: [],
  }
}

function details(): PromptPermissionDetails {
  return {
    requestId: 'request-1',
    source: 'tool_call',
    agentName: null,
    payload: promptPayload(),
    toolName: 'bash',
    command: 'pnpm publish',
    surface: 'bash',
  }
}

describe('review subpath', () => {
  it('exports exactly the documented pipeline', () => {
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

  it('re-exports the bindings the reviewer runs, not copies', () => {
    expect(review.renderTranscript).toBe(renderTranscript)
    expect(review.buildReviewPrompt).toBe(buildReviewPrompt)
    expect(review.buildSystemPrompt).toBe(buildSystemPrompt)
    expect(review.parseReviewAssessment).toBe(parseReviewAssessment)
    expect(review.DEFAULT_CONFIG).toBe(DEFAULT_CONFIG)
    expect(review.POLICY_REVISION).toBe(POLICY_REVISION)
  })

  it('builds a prompt and parses a verdict without a Pi session', () => {
    const prompt = review.buildReviewPrompt(review.DEFAULT_CONFIG, review.renderTranscript([]), details())

    expect(prompt.systemPrompt.startsWith(review.FIXED_REVIEW_PROTOCOL)).toBe(true)
    expect(prompt.userPrompt).toContain('>>> TRANSCRIPT JSONL START')
    expect(prompt.userPrompt).toContain('>>> PERMISSION REQUEST START')
    expect(prompt.userPrompt).toContain('pnpm publish')
    expect(review.parseReviewAssessment('{"outcome":"allow"}')).toMatchObject({ outcome: 'allow', riskLevel: 'low' })
  })
})
