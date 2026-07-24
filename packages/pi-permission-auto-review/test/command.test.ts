import type { AutoReviewCommandController } from '../src/command.js'
import type { AutoReviewConfigFileSystem } from '../src/config-store.js'
import type { LoadConfigResult } from '../src/config.js'
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from '@earendil-works/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import { registerAutoReviewCommand } from '../src/command.js'
import { AutoReviewConfigStore } from '../src/config-store.js'

function createFileSystem(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const readFile = vi.fn((path: string) => files.get(path))
  const writeFile = vi.fn((path: string, source: string) => {
    files.set(path, source)
  })
  const rename = vi.fn((sourcePath: string, destinationPath: string) => {
    const source = files.get(sourcePath)
    if (source === undefined) {
      throw new Error(`missing ${sourcePath}`)
    }
    files.set(destinationPath, source)
    files.delete(sourcePath)
  })
  const mkdir = vi.fn((_path: string) => {})
  const unlink = vi.fn((path: string) => {
    files.delete(path)
  })
  const fileSystem: AutoReviewConfigFileSystem = {
    readFile,
    writeFile,
    rename,
    mkdir,
    unlink,
  }
  return { files, fileSystem }
}

function createCommandHarness(initial: Record<string, string> = {}) {
  const { files, fileSystem } = createFileSystem(initial)
  const configStore = new AutoReviewConfigStore({ agentDir: '/agent', fileSystem })
  let activeConfig = configStore.load('/project').config
  const applyConfig = vi.fn((result: LoadConfigResult) => {
    activeConfig = result.config
    return { kind: 'active' as const }
  })
  const controller: AutoReviewCommandController = {
    configStore,
    getActiveConfig: () => activeConfig,
    applyConfig,
  }

  let command: Omit<RegisteredCommand, 'name' | 'sourceInfo'> | undefined
  const registerCommand = vi.fn((_name: string, options: Omit<RegisteredCommand, 'name' | 'sourceInfo'>) => {
    command = options
  })
  const pi = {
    registerCommand,
  } as unknown as ExtensionAPI
  registerAutoReviewCommand(pi, controller)

  const ui = {
    select: vi.fn(),
    input: vi.fn(),
    editor: vi.fn(),
    confirm: vi.fn(),
    notify: vi.fn(),
  }
  const reload = vi.fn()
  const waitForIdle = vi.fn(async () => {})
  const context = {
    cwd: '/project',
    mode: 'tui',
    hasUI: true,
    modelRegistry: {
      getAll: () => [],
    },
    ui,
    waitForIdle,
    reload,
  } as unknown as ExtensionCommandContext

  return {
    activeConfig: () => activeConfig,
    applyConfig,
    command: () => {
      if (command === undefined) {
        throw new Error('command not registered')
      }
      return command
    },
    context,
    files,
    pi,
    registerCommand,
    reload,
    ui,
    waitForIdle,
  }
}

const globalPath = '/agent/extensions/pi-permission-auto-review/config.json'
const projectPath = '/project/.pi/extensions/pi-permission-auto-review/config.json'

describe('/permission-auto-review', () => {
  it('registers the command and completes subcommands and reset scopes', async () => {
    const harness = createCommandHarness()
    expect(harness.registerCommand).toHaveBeenCalledWith('permission-auto-review', expect.any(Object))

    const command = harness.command()
    expect(await command.getArgumentCompletions?.('sh')).toEqual([expect.objectContaining({ value: 'show' })])
    expect(await command.getArgumentCompletions?.('reset p')).toEqual([
      expect.objectContaining({ value: 'reset project' }),
    ])
  })

  it('edits a staged global draft, saves it, and applies it without ctx.reload', async () => {
    const harness = createCommandHarness()
    let menuVisits = 0
    const menuOptions: string[][] = []
    harness.ui.select.mockImplementation(async (title: string, options: string[]) => {
      if (title === 'Select configuration scope') {
        return 'Global configuration'
      }
      if (title === 'Configure Provider') {
        return 'Enter custom value...'
      }
      if (title.startsWith('Permission auto-review settings')) {
        menuOptions.push(options)
        menuVisits += 1
        return menuVisits === 1 ? options.find(option => option.startsWith('Provider:')) : 'Save changes'
      }
      return undefined
    })
    harness.ui.input.mockResolvedValue('review-proxy')

    await harness.command().handler('', harness.context)

    expect(harness.waitForIdle).toHaveBeenCalledOnce()
    expect(harness.applyConfig).toHaveBeenCalledOnce()
    expect(harness.activeConfig()).toMatchObject({ provider: 'review-proxy' })
    expect(JSON.parse(harness.files.get(globalPath) ?? '')).toMatchObject({
      provider: 'review-proxy',
    })
    expect(menuOptions[0]).toContain('Provider: openai-codex (source: default; global: inherit)')
    expect(menuOptions[1]).toContain('Provider: review-proxy (source: global; global: override)')
    expect(harness.reload).not.toHaveBeenCalled()
    expect(harness.ui.notify).toHaveBeenCalledWith('Config saved and applied without reloading the Pi session.', 'info')
  })

  it('cancels the settings menu without writing or applying', async () => {
    const harness = createCommandHarness()
    harness.ui.select.mockResolvedValueOnce('Project configuration').mockResolvedValueOnce('Cancel')

    await harness.command().handler('', harness.context)

    expect(harness.files.has(projectPath)).toBe(false)
    expect(harness.applyConfig).not.toHaveBeenCalled()
  })

  it('shows active values without exposing the additional policy body', async () => {
    const harness = createCommandHarness({
      [globalPath]: JSON.stringify({
        reasoning: 'high',
        additionalPolicy: 'Private policy contents',
      }),
    })

    await harness.command().handler('show', harness.context)

    const message = harness.ui.notify.mock.calls[0]?.[0] as string
    expect(message).toContain('reasoning=high (global)')
    expect(message).toContain('additionalPolicy=configured (global)')
    expect(message).not.toContain('Private policy contents')
  })

  it('reports both config paths and command help', async () => {
    const harness = createCommandHarness()

    await harness.command().handler('path', harness.context)
    await harness.command().handler('help', harness.context)

    expect(harness.ui.notify).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(`global=${globalPath}\nproject=${projectPath}`),
      'info',
    )
    expect(harness.ui.notify).toHaveBeenNthCalledWith(
      2,
      'Usage: /permission-auto-review [show|path|reset [global|project]|help]',
      'info',
    )
  })

  it('resets an invalid scope and hot-applies the inherited config', async () => {
    const harness = createCommandHarness({
      [projectPath]: JSON.stringify({ apiKey: 'invalid' }),
    })
    harness.ui.confirm.mockResolvedValue(true)

    await harness.command().handler('reset project', harness.context)

    expect(harness.waitForIdle).toHaveBeenCalledOnce()
    expect(harness.files.has(projectPath)).toBe(false)
    expect(harness.applyConfig).toHaveBeenCalledOnce()
    expect(harness.activeConfig()).toMatchObject({
      provider: 'openai-codex',
      model: 'codex-auto-review',
    })
    expect(harness.reload).not.toHaveBeenCalled()
  })

  it('keeps the interactive editor disabled outside TUI mode', async () => {
    const harness = createCommandHarness()
    const context = {
      ...harness.context,
      mode: 'rpc',
    } as ExtensionCommandContext

    await harness.command().handler('', context)

    expect(harness.ui.select).not.toHaveBeenCalled()
    expect(harness.ui.notify).toHaveBeenCalledWith('/permission-auto-review requires interactive TUI mode.', 'warning')
  })
})
