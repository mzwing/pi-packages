import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildJsonSchema, configPaths, DEFAULT_CONFIG, loadConfig } from '../src/config.js'
import { useWorkspace, writeFile } from './helpers.js'

describe('loadConfig', () => {
  const workspace = useWorkspace()

  it('merges tiers key by key, so a project ranking one slug keeps the global ranks', () => {
    const paths = configPaths(workspace.cwd)
    writeFile(paths.global, { tiers: { 'gpt-6-astra': 100, 'gpt-5.4': 38 } })
    writeFile(paths.project, { tiers: { 'gpt-5.4': 10, 'relay-house': 5 } })

    expect(loadConfig(workspace.cwd).config.tiers).toEqual({ 'gpt-6-astra': 100, 'gpt-5.4': 10, 'relay-house': 5 })
  })

  it('applies neither scope when one is unusable, rather than half a config', () => {
    const paths = configPaths(workspace.cwd)
    writeFile(paths.global, { notify: false })
    writeFile(paths.project, { notifyy: true })

    const { config, issues } = loadConfig(workspace.cwd)
    expect(config).toEqual(DEFAULT_CONFIG)
    expect(issues).toEqual([expect.stringContaining(paths.project)])
  })
})

it('publishes the schema the config is validated with', () => {
  const committed: unknown = JSON.parse(readFileSync(new URL('../schemas/config.schema.json', import.meta.url), 'utf8'))

  expect(committed).toEqual(buildJsonSchema())
})
