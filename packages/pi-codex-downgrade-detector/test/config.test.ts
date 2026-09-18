import { describe, expect, it } from 'vitest'
import { buildDetectorJsonSchema, DEFAULT_CONFIG, getDetectorConfigPaths, loadDetectorConfig } from '../src/config.js'

function load(files: Record<string, string>) {
  return loadDetectorConfig({ cwd: '/workspace', agentDir: '/agent', readFile: path => files[path] })
}

const { globalPath, projectPath } = getDetectorConfigPaths('/workspace', '/agent')

describe('loadDetectorConfig', () => {
  it('falls back to defaults when neither scope exists', () => {
    expect(load({}).config).toEqual(DEFAULT_CONFIG)
  })

  it('lets the project scope override the global one', () => {
    const result = load({
      [globalPath]: JSON.stringify({ providers: ['openai-codex'], notify: false }),
      [projectPath]: JSON.stringify({ providers: ['my-relay'] }),
    })

    expect(result.config).toMatchObject({ providers: ['my-relay'], notify: false })
  })

  it('merges tiers across scopes instead of replacing them', () => {
    const result = load({
      [globalPath]: JSON.stringify({ tiers: { 'gpt-6-astra': 100, 'gpt-5.4': 38 } }),
      [projectPath]: JSON.stringify({ tiers: { 'gpt-5.4': 10, 'relay-house': 5 } }),
    })

    expect(result.config?.tiers).toEqual({ 'gpt-6-astra': 100, 'gpt-5.4': 10, 'relay-house': 5 })
  })

  it('records invalid JSON and yields no config rather than a half-applied one', () => {
    const result = load({ [projectPath]: '{ not json' })

    expect(result.config).toBeUndefined()
    expect(result.issues[0]?.message).toContain('invalid JSON')
  })

  it('rejects an unknown key so a typo is not silently ignored', () => {
    const result = load({ [projectPath]: JSON.stringify({ notifyy: true }) })

    expect(result.config).toBeUndefined()
    expect(result.issues).toHaveLength(1)
  })
})

describe('buildDetectorJsonSchema', () => {
  it('publishes a schema that carries its own id', () => {
    const schema = buildDetectorJsonSchema()

    expect(schema['$id']).toContain('pi-codex-downgrade-detector/schemas/config.schema.json')
    expect(schema['properties']).toHaveProperty('tiers')
  })
})
