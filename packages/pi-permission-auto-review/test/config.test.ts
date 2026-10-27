import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { buildJsonSchema, mergeConfig, validateConfigFile } from '../src/config.js'

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

it('accepts 0 to 20 retries and attempt timeouts of 1 ms to 300 s, in whole numbers only', () => {
  for (const valid of [{ maxRetries: 0 }, { maxRetries: 20 }, { attemptTimeoutMs: 1 }, { attemptTimeoutMs: 300_000 }]) {
    expect(validateConfigFile(valid)).toMatchObject({ ok: true, config: valid })
  }
  for (const invalid of [
    { maxRetries: -1 },
    { maxRetries: 21 },
    { maxRetries: 1.5 },
    { attemptTimeoutMs: 0 },
    { attemptTimeoutMs: 300_001 },
    { attemptTimeoutMs: 1.5 },
  ]) {
    expect(validateConfigFile(invalid).ok).toBe(false)
  }
})
