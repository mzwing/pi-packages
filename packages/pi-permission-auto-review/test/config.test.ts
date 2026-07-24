import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_MODEL, DEFAULT_PROVIDER, buildAutoReviewJsonSchema, loadAutoReviewConfig } from '../src/config.js'

describe('loadAutoReviewConfig', () => {
  it('uses safe defaults when no config exists', () => {
    const result = loadAutoReviewConfig({
      agentDir: '/agent',
      cwd: '/project',
      readFile: () => undefined,
    })

    expect(result.issues).toEqual([])
    expect(result.config).toMatchObject({
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      reasoning: 'low',
      timeoutMs: 90_000,
      includeBaselinePolicy: true,
    })
  })

  it('merges project fields over global fields', () => {
    const files = new Map([
      [
        '/agent/extensions/pi-permission-auto-review/config.json',
        JSON.stringify({
          provider: 'global-provider',
          model: 'global-model',
          timeoutMs: 10_000,
          additionalPolicy: 'Global policy',
        }),
      ],
      [
        '/project/.pi/extensions/pi-permission-auto-review/config.json',
        JSON.stringify({
          model: 'project-model',
          timeoutMs: 20_000,
        }),
      ],
    ])

    const result = loadAutoReviewConfig({
      agentDir: '/agent',
      cwd: '/project',
      readFile: path => files.get(path),
    })

    expect(result.config).toMatchObject({
      provider: 'global-provider',
      model: 'project-model',
      timeoutMs: 20_000,
      additionalPolicy: 'Global policy',
    })
  })

  it('disables automatic decisions for invalid config', () => {
    const files = new Map([
      [
        '/project/.pi/extensions/pi-permission-auto-review/config.json',
        JSON.stringify({
          includeBaselinePolicy: false,
        }),
      ],
    ])

    const result = loadAutoReviewConfig({
      agentDir: '/agent',
      cwd: '/project',
      readFile: path => files.get(path),
    })

    expect(result.config).toBeUndefined()
    expect(result.issues[0]?.message).toContain('additionalPolicy is required')
  })

  it('rejects unknown fields rather than silently ignoring them', () => {
    const result = loadAutoReviewConfig({
      agentDir: '/agent',
      cwd: '/project',
      readFile: path => (path.startsWith('/project') ? JSON.stringify({ apiKey: 'must-not-live-here' }) : undefined),
    })

    expect(result.config).toBeUndefined()
    expect(result.issues[0]?.message).toContain('Unrecognized key')
  })
})

describe('published JSON Schema', () => {
  it('matches the Zod source of truth', () => {
    const published: unknown = JSON.parse(
      readFileSync(new URL('../schemas/config.schema.json', import.meta.url), 'utf8'),
    )

    expect(published).toEqual(buildAutoReviewJsonSchema())
  })
})
