import type { LoadConfigResult } from '../src/config-store.js'
import type { AutoReviewConfig } from '../src/config.js'
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from '@earendil-works/pi-coding-agent'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { registerAutoReviewCommand } from '../src/command.js'
import { configPath, loadConfig } from '../src/config-store.js'
import { useWorkspace, writeFile } from './helpers.js'

type Command = Omit<RegisteredCommand, 'name' | 'sourceInfo'>

describe('/permission-auto-review', () => {
  const workspace = useWorkspace()

  /** Answers the settings menu with `picks` in order, then saves; other dialogs come from `answers` by title. */
  function setup(picks: string[], answers: Record<string, string> = {}, projectTrusted = true) {
    let activeConfig: AutoReviewConfig | undefined = loadConfig(workspace.cwd, projectTrusted).config
    const applyConfig = vi.fn((result: LoadConfigResult) => {
      activeConfig = result.config

      return { kind: 'active' as const }
    })
    let command: Command | undefined
    registerAutoReviewCommand(
      {
        registerCommand: (_name: string, options: Command) => {
          command = options
        },
      } as unknown as ExtensionAPI,
      { getActiveConfig: () => activeConfig, applyConfig },
    )

    const menus: string[][] = []
    const select = vi.fn(async (title: string, options: string[]) => {
      if (!title.startsWith('Permission auto-review settings')) {
        return answers[title]
      }
      menus.push(options)
      const field = picks[menus.length - 1]

      return field === undefined ? 'Save changes' : options.find(option => option.startsWith(field))
    })
    const reload = vi.fn()
    const notify = vi.fn()
    const context = {
      cwd: workspace.cwd,
      mode: 'tui',
      modelRegistry: { getAll: () => [] },
      ui: { select, input: async () => answers['input'], notify },
      waitForIdle: async () => {},
      isProjectTrusted: () => projectTrusted,
      reload,
    } as unknown as ExtensionCommandContext

    return {
      run: async (args: string) => command?.handler(args, context),
      activeConfig: () => activeConfig,
      applyConfig,
      menus,
      notify,
      reload,
    }
  }

  const stored = (scope: 'global' | 'project'): unknown =>
    JSON.parse(readFileSync(configPath(workspace.cwd, scope), 'utf8'))

  it('stages edits in the menu, then saves and applies them without reloading the session', async () => {
    const harness = setup(['Provider:'], {
      'Select configuration scope': 'Global configuration',
      'Configure Provider': 'Enter custom value...',
      input: 'review-proxy',
    })
    await harness.run('')

    expect(harness.menus[0]).toContain('Provider: openai-codex (source: default; global: inherit)')
    expect(harness.menus[1]).toContain('Provider: review-proxy (source: global; global: override)')
    expect(stored('global')).toMatchObject({ provider: 'review-proxy' })
    expect(harness.applyConfig).toHaveBeenCalledOnce()
    expect(harness.activeConfig()).toMatchObject({ provider: 'review-proxy' })
    expect(harness.reload).not.toHaveBeenCalled()
  })

  it('drops an override that is set back to the inherited value', async () => {
    writeFile(configPath(workspace.cwd, 'global'), { reasoning: 'high', model: 'kept-model' })
    const harness = setup(['Reasoning:'], {
      'Select configuration scope': 'Global configuration',
      'Configure Reasoning': 'Use inherited value',
    })
    await harness.run('')

    expect(Object.keys(stored('global') as object)).toEqual(['$schema', 'model'])
    expect(harness.activeConfig()).toMatchObject({ reasoning: 'low', model: 'kept-model' })
  })

  it('shows the active values with their origins, but never the policy body', async () => {
    writeFile(configPath(workspace.cwd, 'global'), { reasoning: 'high', additionalPolicy: 'Private policy contents' })
    const harness = setup([])
    await harness.run('show')

    const message = String(harness.notify.mock.calls[0]?.[0])
    expect(message).toContain('reasoning=high (global)')
    expect(message).toContain('additionalPolicy=configured (global)')
    expect(message).not.toContain('Private policy contents')
  })

  it('keeps an untrusted project out of the menu and marks it ignored in show', async () => {
    writeFile(configPath(workspace.cwd, 'project'), { reasoning: 'high' })
    const harness = setup([], { 'Select configuration scope': 'Project configuration' }, false)
    await harness.run('')

    expect(harness.notify).toHaveBeenCalledWith('Project config is ignored until Pi trusts this project.', 'warning')
    expect(harness.menus).toHaveLength(0)

    await harness.run('show')
    const message = String(harness.notify.mock.calls[1]?.[0])
    expect(message).toContain('reasoning=low (default)')
    expect(message).toContain('(ignored until Pi trusts this project)')
  })
})
