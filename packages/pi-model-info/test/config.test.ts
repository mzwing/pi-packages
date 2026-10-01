import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildJsonSchema, loadConfig } from '../src/config.js'
import { useWorkspace, writeFile } from './helpers.js'

describe('loadConfig', () => {
  const workspace = useWorkspace()
  const globalPath = (): string => join(workspace.agentDir, 'extensions', 'pi-model-info', 'config.json')

  function load(config: unknown): ReturnType<typeof loadConfig> {
    writeFile(globalPath(), config)

    return loadConfig(workspace.cwd)
  }

  // Model ids routinely contain '/', so only a known provider head disambiguates a flat key.
  it('splits a flat key at its first separator and folds it into the nested gate', () => {
    const { config, issues } = load({
      providers: { relay: { models: { 'anthropic/claude-x': { skip: false } } } },
      aliases: { 'relay/anthropic/claude-x': 'anthropic/claude-opus-4.7' },
    })

    expect(issues).toEqual([])
    expect(config?.providers.get('relay')?.models.get('anthropic/claude-x')).toEqual({
      skip: false,
      alias: 'anthropic/claude-opus-4.7',
    })
  })

  it('reports and drops an unusable entry while the rest still applies', () => {
    const { config, issues } = load({
      providers: { relay: { models: { m: { suffixes: ['free-dash', 'ghost'] } } } },
      aliases: { 'other/m': 'openai/gpt-5.5' },
    })

    expect(issues).toEqual([
      `${globalPath()}: aliases['other/m'] does not start with an opted-in provider id`,
      `${globalPath()}: providers['relay'].models['m'] references unknown rule 'ghost'`,
    ])
    expect(config?.providers.get('relay')?.models.get('m')?.suffixes).toEqual(['free-dash'])
  })

  it('orders rules longest value first, so a broad suffix cannot shadow a specific one', () => {
    const { config } = load({ providers: {}, rules: [{ id: 'long', kind: 'suffix', value: '-preview-free' }] })

    expect(config?.suffixRules.map(rule => rule.id)).toEqual(['long', 'free-dash', 'free-colon'])
  })
})

it('publishes the schema the config is validated with', () => {
  const committed: unknown = JSON.parse(readFileSync(new URL('../schemas/config.schema.json', import.meta.url), 'utf8'))

  expect(committed).toEqual(buildJsonSchema())
})
