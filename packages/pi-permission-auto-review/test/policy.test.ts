import { expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import { buildSystemPrompt, FIXED_REVIEW_PROTOCOL } from '../src/policy.js'

const OPERATOR_POLICY = 'Deny the abstract forbidden operation.'

// Upstream renders operator policy in its `{{ extra_policy }}` slot, closing the security policy.
it('adds operator policy as restrictive security policy, ahead of the outcome rules that apply it', () => {
  const prompt = buildSystemPrompt({ ...DEFAULT_CONFIG, additionalPolicy: OPERATOR_POLICY })
  const operatorPolicy = prompt.indexOf(`## Operator Policy\n${OPERATOR_POLICY}`)

  expect(prompt).toContain('conflicts resolve to the more restrictive outcome')
  expect(operatorPolicy).toBeGreaterThan(prompt.indexOf('## Low-Risk Actions'))
  expect(operatorPolicy).toBeLessThan(prompt.indexOf('# Outcome Policy'))
})

it('keeps the evidence boundary and output protocol when operator policy replaces the baseline', () => {
  const prompt = buildSystemPrompt({
    ...DEFAULT_CONFIG,
    includeBaselinePolicy: false,
    additionalPolicy: OPERATOR_POLICY,
  })

  expect(prompt.startsWith(FIXED_REVIEW_PROTOCOL)).toBe(true)
  expect(prompt).toContain(OPERATOR_POLICY)
  expect(prompt).not.toContain('# Base Risk Taxonomy')
  expect(prompt).not.toContain('# Outcome Policy')
})
