import type { ModelInfoConfig } from '../src/types.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildModelInfoJsonSchema,
  getModelInfoConfigPaths,
  loadModelInfoConfig,
  resolveModelInfoConfig,
} from '../src/config.js'

const AGENT_DIR = '/agent'
const CWD = '/project'
const { globalPath, projectPath } = getModelInfoConfigPaths(CWD, AGENT_DIR)

function load(files: Record<string, unknown>): ReturnType<typeof loadModelInfoConfig> {
  return loadModelInfoConfig({
    cwd: CWD,
    agentDir: AGENT_DIR,
    readFile: path => (path in files ? JSON.stringify(files[path]) : undefined),
  })
}

function resolve(config: ModelInfoConfig): ReturnType<typeof resolveModelInfoConfig> {
  return resolveModelInfoConfig(config, globalPath)
}

describe('loading', () => {
  it('defaults to an empty, inert config', () => {
    const result = load({})
    expect(result.issues).toEqual([])
    expect(result.config?.providers).toEqual({})
  })

  it('lets the project scope win over the global one', () => {
    const result = load({
      [globalPath]: { providers: { a: {} }, builtinRules: false },
      [projectPath]: { providers: { b: {} } },
    })
    expect(Object.keys(result.config?.providers ?? {})).toEqual(['b'])
    expect(result.config?.builtinRules).toBe(false)
  })

  it('accepts $schema but rejects an unknown key', () => {
    expect(load({ [globalPath]: { $schema: './schema.json', providers: {} } }).config).toBeDefined()

    const result = load({ [globalPath]: { providers: {}, nope: 1 } })
    expect(result.config).toBeUndefined()
    expect(result.issues[0]?.sourcePath).toBe(globalPath)
  })

  it('reports invalid JSON without throwing', () => {
    const result = loadModelInfoConfig({ cwd: CWD, agentDir: AGENT_DIR, readFile: () => '{' })
    expect(result.config).toBeUndefined()
    expect(result.issues[0]?.message).toContain('invalid JSON')
  })

  it('rejects a duplicate rule id', () => {
    const result = load({
      [globalPath]: {
        providers: {},
        rules: [
          { id: 'a', kind: 'suffix', value: '-x' },
          { id: 'a', kind: 'suffix', value: '-y' },
        ],
      },
    })
    expect(result.config).toBeUndefined()
  })

  it('rejects a repeated source', () => {
    expect(load({ [globalPath]: { providers: {}, sources: ['pi.dev', 'pi.dev'] } }).config).toBeUndefined()
  })
})

describe('desugaring', () => {
  it('splits a flat key at the first separator', () => {
    // Model ids routinely contain '/', so only a known provider head disambiguates.
    const { config, issues } = resolve({
      providers: { relay: {} },
      aliases: { 'relay/anthropic/claude-x': 'anthropic/claude-opus-4.7' },
    })
    expect(issues).toEqual([])
    expect(config.providers.get('relay')?.models.get('anthropic/claude-x')?.alias).toBe('anthropic/claude-opus-4.7')
  })

  it('reports a flat key whose head is not an opted-in provider', () => {
    const { config, issues } = resolve({ providers: { relay: {} }, aliases: { 'other/m': 'openai/gpt-5.5' } })
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain('opted-in provider id')
    expect(config.providers.get('relay')?.models.size).toBe(0)
  })

  it('merges flat sugar into an existing nested gate', () => {
    const { config } = resolve({
      providers: { relay: { models: { m: { skip: true } } } },
      models: { 'relay/m': { suffixes: [] } },
    })
    expect(config.providers.get('relay')?.models.get('m')).toEqual({ skip: true, suffixes: [] })
  })
})

describe('rules', () => {
  it('includes the built-ins and orders every rule longest-value-first', () => {
    const { config } = resolve({
      providers: {},
      rules: [{ id: 'long', kind: 'suffix', value: '-preview-free' }],
    })
    expect(config.suffixRules.map(rule => rule.id)).toEqual(['long', 'free-dash', 'free-colon'])
  })

  it('drops the built-ins when asked', () => {
    const { config } = resolve({ providers: {}, builtinRules: false })
    expect(config.suffixRules).toEqual([])
  })

  it('omits a rule that is explicitly disabled', () => {
    const { config } = resolve({
      providers: {},
      builtinRules: false,
      rules: [{ id: 'off', kind: 'suffix', value: '-x', enabled: false }],
    })
    expect(config.suffixRules).toEqual([])
  })

  it('drops an unknown rule id from a gate and reports it', () => {
    const { config, issues } = resolve({
      providers: { relay: { models: { m: { suffixes: ['free-dash', 'ghost'] } } } },
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain("unknown rule 'ghost'")
    expect(config.providers.get('relay')?.models.get('m')?.suffixes).toEqual(['free-dash'])
  })

  it('keeps an empty gate list distinct from an absent one', () => {
    const { config } = resolve({ providers: { relay: { models: { m: { suffixes: [] } } } } })
    expect(config.providers.get('relay')?.models.get('m')?.suffixes).toEqual([])
    expect(config.providers.get('relay')?.models.get('m')?.prefixes).toBeUndefined()
  })
})

describe('defaults', () => {
  it('materialises the documented per-provider defaults', () => {
    const { config } = resolve({ providers: { relay: {} } })
    expect(config.providers.get('relay')).toMatchObject({
      costMultiplier: 1,
      costPolicy: 'catalog',
      contextWindowPolicy: 'catalog',
      capabilityPolicy: 'catalog',
      useCatalogName: false,
      mapThinkingLevels: false,
      allowDynamic: false,
    })
    expect(config.sources).toEqual(['pi.dev', 'models.dev'])
    expect(config.applyOnIdleOnly).toBe(true)
    expect(config.network.enabled).toBe(true)
  })
})

describe('published schema', () => {
  it('matches the committed file', () => {
    // Compared as data, not text: the committed copy is oxfmt's to format.
    const path = fileURLToPath(new URL('../schemas/config.schema.json', import.meta.url))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(buildModelInfoJsonSchema())
  })
})
