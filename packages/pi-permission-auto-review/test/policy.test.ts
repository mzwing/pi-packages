import { describe, expect, it } from 'vitest'
import { autoReviewConfigSchema } from '../src/config.js'
import { POLICY_REVISION, buildSystemPrompt } from '../src/policy.js'

function config(overrides: Record<string, unknown> = {}) {
  return autoReviewConfigSchema.parse(overrides)
}

describe('guardian policy', () => {
  it('records the pinned upstream revision and trusted Pi provenance boundary', () => {
    const prompt = buildSystemPrompt(config())

    expect(POLICY_REVISION).toBe('openai-codex/c4f42d161ae44a8d696ee9fb595709661979d187+pi1')
    expect(prompt).toContain('source field is "user" or "user_interaction"')
    expect(prompt).toContain('ask_user_question or plan_mode_question')
    expect(prompt).toContain('branch summary, compaction summary')
  })

  it('includes necessary implementation, local edit, re-approval, and outcome guidance', () => {
    const prompt = buildSystemPrompt(config())

    expect(prompt).toContain('necessary implementation of that user-requested operation')
    expect(prompt).toContain('updating a small user-owned file are usually low')
    expect(prompt).toContain('re-approves the exact denied action')
    expect(prompt).toContain('Allow low and medium risk actions regardless of authorization')
    expect(prompt).toContain('explicit user prohibition remains effective')
    expect(prompt).toContain('You have no tools')
  })

  it('composes operator policy restrictively when the baseline is enabled', () => {
    const prompt = buildSystemPrompt(
      config({
        additionalPolicy: 'Deny the abstract forbidden operation.',
      }),
    )

    expect(prompt).toContain('# Base Risk Taxonomy')
    expect(prompt).toContain('Deny the abstract forbidden operation.')
    expect(prompt).toContain('conflicts resolve to the more restrictive outcome')
  })

  it('keeps the fixed provenance and output protocol when operator policy replaces the baseline', () => {
    const prompt = buildSystemPrompt(
      config({
        includeBaselinePolicy: false,
        additionalPolicy: 'Use the operator-defined classification.',
      }),
    )

    expect(prompt).not.toContain('# Base Risk Taxonomy')
    expect(prompt).toContain('Apply only the operator policy below')
    expect(prompt).toContain('Use the operator-defined classification.')
    expect(prompt).toContain('source field is "user" or "user_interaction"')
    expect(prompt).toContain('Return one JSON object and no prose')
  })
})
