import type { AutoReviewConfig } from '../../src/config/config.js'
import type { LoadConfigResult } from '../../src/config/store.js'
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from '@earendil-works/pi-coding-agent'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { registerAutoReviewCommand } from '../../src/config/command.js'
import { configPath, loadConfig } from '../../src/config/store.js'
import { useWorkspace, writeFile } from '../helpers.js'

type Command = Omit<RegisteredCommand, 'name' | 'sourceInfo'>

describe('/permission-auto-review', () => {
  const workspace = useWorkspace()

  /** Answers the settings menu with `picks` in order, then saves; other dialogs come from `answers` by title */
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
      ui: { select, input: async () => answers['input'], editor: async () => answers['editor'], notify },
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

  it('shows the active values with their origins, but never the rules', async () => {
    writeFile(configPath(workspace.cwd, 'global'), {
      reasoning: 'high',
      autoMode: { soft_deny: ['$defaults', 'Private policy contents'] },
    })
    const harness = setup([])
    await harness.run('show')

    const message = String(harness.notify.mock.calls[0]?.[0])
    expect(message).toContain('reasoning=high (global)')
    expect(message).toContain('autoMode.soft_deny=$defaults + 1 custom (global)')
    expect(message).toContain('autoMode.allow=$defaults (default)')
    expect(message).not.toContain('Private policy contents')
  })

  // Rules copied from Claude Code span several lines
  it('edits a rule list one rule per paragraph', async () => {
    const harness = setup(['Soft deny rules:'], {
      'Select configuration scope': 'Global configuration',
      'Configure Soft deny rules': 'Edit rules...',
      editor: '$defaults\n\nForce pushes: never\nto main.\n\n\nNever run migrations by hand.\n',
    })
    await harness.run('')

    expect(stored('global')).toMatchObject({
      autoMode: { soft_deny: ['$defaults', 'Force pushes: never\nto main.', 'Never run migrations by hand.'] },
    })
    expect(harness.menus[1]).toContain('Soft deny rules: $defaults + 2 custom (source: global; global: override)')
  })

  it('drops a rule list set back to the inherited one, and an emptied autoMode block with it', async () => {
    writeFile(configPath(workspace.cwd, 'global'), { autoMode: { soft_deny: ['Never run migrations by hand.'] } })
    const harness = setup(['Soft deny rules:'], {
      'Select configuration scope': 'Global configuration',
      'Configure Soft deny rules': 'Use inherited value',
    })
    await harness.run('')

    expect(Object.keys(stored('global') as object)).toEqual(['$schema'])
    expect(harness.activeConfig()?.autoMode.soft_deny).toEqual(['$defaults'])
  })

  it('offers the provider and model of the preset it switches to as the inherited ones', async () => {
    const harness = setup(['Preset:'], {
      'Select configuration scope': 'Global configuration',
      'Configure Preset': 'claude-code',
    })
    await harness.run('')

    expect(harness.menus[1]).toContain('Provider: anthropic (source: default; global: inherit)')
    expect(harness.menus[1]).toContain('Model: claude-sonnet-5 (source: default; global: inherit)')
    expect(stored('global')).toMatchObject({ preset: 'claude-code' })
  })

  it('lists the names of the built-in rules $defaults stands for under the active preset', async () => {
    writeFile(configPath(workspace.cwd, 'global'), { preset: 'claude-code' })
    const harness = setup([])
    await harness.run('defaults')

    const message = String(harness.notify.mock.calls[0]?.[0])
    expect(message).toMatch(/\nhard_deny: Data Exfiltration$/)
    expect(message).toContain('soft_deny: Git Destructive, Irreversible Local Destruction, ')
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

  it('edits the retry count and the attempt timeout', async () => {
    const harness = setup(['Retries:', 'Attempt timeout:'], {
      'Select configuration scope': 'Global configuration',
      'Configure Retries': 'Enter custom value...',
      'Configure Attempt Timeout': 'Enter custom value...',
      input: '20',
    })
    await harness.run('')

    expect(harness.menus[0]).toContain('Retries: 2 (source: default; global: inherit)')
    expect(harness.menus[0]).toContain('Attempt timeout: not set (source: default; global: inherit)')
    expect(harness.menus[2]).toContain('Retries: 20 (source: global; global: override)')
    expect(harness.menus[2]).toContain('Attempt timeout: 20 ms (source: global; global: override)')
    expect(stored('global')).toMatchObject({ maxRetries: 20, attemptTimeoutMs: 20 })
  })

  it('warns about a value the config rejects and keeps the draft', async () => {
    const harness = setup(['Attempt timeout:'], {
      'Select configuration scope': 'Global configuration',
      'Configure Attempt Timeout': 'Enter custom value...',
      input: '30s',
    })
    await harness.run('')

    expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining('attemptTimeoutMs'), 'warning')
    expect(harness.menus[1]).toContain('Attempt timeout: not set (source: default; global: inherit)')
  })

  it('lets a project field fall back to the global one, field by field', async () => {
    writeFile(configPath(workspace.cwd, 'global'), { maxRetries: 7, attemptTimeoutMs: 60_000 })
    writeFile(configPath(workspace.cwd, 'project'), { maxRetries: 0 })
    const harness = setup(['Retries:'], {
      'Select configuration scope': 'Project configuration',
      'Configure Retries': 'Use inherited value',
    })
    await harness.run('')

    expect(harness.menus[0]).toContain('Retries: 0 (source: project; project: override)')
    expect(harness.menus[0]).toContain('Attempt timeout: 60000 ms (source: global; project: inherit)')
    expect(harness.activeConfig()).toMatchObject({ maxRetries: 7, attemptTimeoutMs: 60_000 })
  })
})
