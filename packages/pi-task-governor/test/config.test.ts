import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildJsonSchema, configPaths, DEFAULT_CONFIG, loadConfig } from '../src/config.js'
import { useWorkspace, writeJson } from './helpers.js'

describe('config', () => {
  const workspace = useWorkspace()

  it('merges the project over the global file role by role, once the project is trusted', () => {
    const paths = configPaths(workspace.repo)
    writeJson(paths.global, { maxExecutors: 2, roles: { developer: { model: 'openai/gpt', maxTurns: 50 } } })
    writeJson(paths.project, { roles: { developer: { thinking: 'high' } }, env: { setup: ['pnpm install'] } })

    expect(loadConfig(workspace.repo, true)).toEqual({
      config: {
        ...DEFAULT_CONFIG,
        maxExecutors: 2,
        roles: { ...DEFAULT_CONFIG.roles, developer: { model: 'openai/gpt', maxTurns: 50, thinking: 'high' } },
        env: { provider: 'auto', setup: ['pnpm install'] },
      },
      issues: [],
    })
    expect(loadConfig(workspace.repo, false).config.env.setup).toEqual([])
  })

  it('falls back to the defaults and reports the issue when a file is invalid', () => {
    writeJson(configPaths(workspace.repo).global, { maxExecutors: 0 })

    const { config, issues } = loadConfig(workspace.repo, true)

    expect(config).toEqual(DEFAULT_CONFIG)
    expect(issues).toEqual([expect.stringContaining('maxExecutors')])
  })

  it('publishes the schema the config is validated with', () => {
    const published: unknown = JSON.parse(
      readFileSync(new URL('../schemas/config.schema.json', import.meta.url), 'utf8'),
    )

    expect(published).toEqual(buildJsonSchema())
  })
})
