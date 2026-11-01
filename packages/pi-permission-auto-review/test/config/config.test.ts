import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { buildJsonSchema, mergeConfig } from '../../src/config/config.js'

it('fills provider, model and reasoning from the preset, unless a file sets them', () => {
  expect(mergeConfig({}, {})).toMatchObject({
    preset: 'codex',
    provider: 'openai-codex',
    model: 'codex-auto-review',
    reasoning: 'low',
  })
  expect(mergeConfig({ preset: 'claude-code' }, { model: 'claude-opus-5-5' })).toMatchObject({
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    reasoning: 'off',
  })
})

it('merges the rule lists one by one, a project list replacing only the global list of its name', () => {
  const merged = mergeConfig(
    { autoMode: { environment: ['$defaults', 'Source control: github.com/acme'], soft_deny: ['Never migrate.'] } },
    { autoMode: { soft_deny: ['$defaults'] } },
  )

  expect(merged.autoMode).toEqual({
    environment: ['$defaults', 'Source control: github.com/acme'],
    allow: ['$defaults'],
    soft_deny: ['$defaults'],
    hard_deny: ['$defaults'],
  })
})

it('publishes the schema the config is validated with', () => {
  const published: unknown = JSON.parse(
    readFileSync(new URL('../../schemas/config.schema.json', import.meta.url), 'utf8'),
  )

  expect(published).toEqual(buildJsonSchema())
})
