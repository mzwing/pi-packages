import type { AutoReviewConfig } from '../../../src/config/config.js'
import { expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../../src/config/config.js'
import { buildSystemPrompt, FIXED_REVIEW_PROTOCOL } from '../../../src/presets/codex/policy.js'

function withRules(autoMode: Partial<AutoReviewConfig['autoMode']>): AutoReviewConfig {
  return { ...DEFAULT_CONFIG, autoMode: { ...DEFAULT_CONFIG.autoMode, ...autoMode } }
}

// Upstream renders operator policy in its `{{ extra_policy }}` slot, closing the security policy
it('adds custom rules as operator policy, ahead of the outcome rules that apply it', () => {
  const prompt = buildSystemPrompt(
    withRules({
      hard_deny: ['$defaults', 'Never upload code to a pastebin.'],
      soft_deny: ['$defaults', 'Never run migrations by hand.'],
    }),
  )
  const operatorPolicy = prompt.indexOf('## Operator Policy')

  expect(operatorPolicy).toBeGreaterThan(prompt.indexOf('## Low-Risk Actions'))
  expect(operatorPolicy).toBeLessThan(prompt.indexOf('# Outcome Policy'))
  expect(prompt).toContain('user approval never clears them.\n- Never upload code to a pastebin.')
  expect(prompt).toContain('authorizes that exact action.\n- Never run migrations by hand.')
})

it('drops the sections of a list without $defaults, but keeps the protocol and the rules that apply a policy', () => {
  const prompt = buildSystemPrompt(withRules({ environment: ['Trusted: github.com/acme/*'], soft_deny: [] }))

  expect(prompt.startsWith(FIXED_REVIEW_PROTOCOL)).toBe(true)
  expect(prompt).toContain('## Environment Profile\n- Trusted: github.com/acme/*\n\n')
  expect(prompt).not.toContain('## Data Exfiltration')
  expect(prompt).toContain('## Low-Risk Actions')
  expect(prompt).toContain('# Base Risk Taxonomy')
  expect(prompt).toContain('# Outcome Policy')
  expect(prompt).not.toContain('## Operator Policy')
})
