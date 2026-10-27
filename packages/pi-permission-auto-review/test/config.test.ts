import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { buildJsonSchema, DEFAULT_CONFIG, mergeConfig, validateConfigFile } from '../src/config.js'

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

it('retries twice by default and sets no attempt timeout', () => {
  expect(DEFAULT_CONFIG.maxRetries).toBe(2)
  expect(DEFAULT_CONFIG).not.toHaveProperty('attemptTimeoutMs')
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
    { retry: { maxRetries: 3 } },
  ]) {
    expect(validateConfigFile(invalid).ok).toBe(false)
  }
})

it('merges the retry fields one by one, without tying them to timeoutMs', () => {
  expect(mergeConfig({ maxRetries: 7, attemptTimeoutMs: 60_000 }, { maxRetries: 0, timeoutMs: 30_000 })).toMatchObject({
    ok: true,
    config: { maxRetries: 0, attemptTimeoutMs: 60_000, timeoutMs: 30_000 },
  })
})
