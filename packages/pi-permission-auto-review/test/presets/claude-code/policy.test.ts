import { expect, it } from 'vitest'
import { buildSystemPrompt } from '../../../src/presets/claude-code/policy.js'

it('splices the built-in rules in where $defaults stands, and leaves them out of a list without it', () => {
  const prompt = buildSystemPrompt(
    {
      environment: ['Source control: github.com/acme', '$defaults'],
      allow: ['$defaults'],
      soft_deny: ['Never run migrations by hand\n  - not even on staging'],
      hard_deny: [],
    },
    [],
  )

  expect(prompt).toContain('\n- Source control: github.com/acme\n- Trusted repo:')
  expect(prompt).toContain(
    'the consent bar is met.\n- Never run migrations by hand\n    - not even on staging\n\n## ALLOW',
  )
  expect(prompt).not.toContain('- Git Destructive [must name')
  expect(prompt).toContain('## HARD BLOCK\nBlock whatever the user said.\n- (none)')
})
