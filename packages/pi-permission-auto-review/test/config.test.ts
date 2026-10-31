import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { buildJsonSchema, mergeConfig } from '../src/config.js'

// The rule spans scopes, so it can only be judged on the merge.
it('requires an operator policy once the baseline is disabled, wherever each half is set', () => {
  expect(mergeConfig({}, { includeBaselinePolicy: false })).toEqual({
    ok: false,
    issue: 'additionalPolicy: additionalPolicy is required when includeBaselinePolicy is false',
  })
  expect(mergeConfig({ additionalPolicy: 'Deny publishing.' }, { includeBaselinePolicy: false }).ok).toBe(true)
})

it('publishes the schema the config is validated with, cross-field rule included', () => {
  const published: unknown = JSON.parse(readFileSync(new URL('../schemas/config.schema.json', import.meta.url), 'utf8'))

  expect(published).toEqual(buildJsonSchema())
})
