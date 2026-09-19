import type { EnhancerCommandController } from '../src/command.js'
import type { ReportView } from '../src/render.js'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import { registerEnhancerCommand } from '../src/command.js'
import { DEFAULT_CONFIG } from '../src/config.js'
import { createHarness } from './helpers.js'

function report(): ReportView {
  return {
    config: DEFAULT_CONFIG,
    paths: { globalPath: '/agent/config.json', projectPath: '/workspace/config.json' },
    storePath: '/agent/tickets.json',
    transport: 'sse',
    ticket: undefined,
    now: 0,
    lastOutcome: undefined,
    nextProbeAt: undefined,
  }
}

function register(overrides: Partial<EnhancerCommandController> = {}): ReturnType<typeof createHarness> {
  const harness = createHarness()
  registerEnhancerCommand(harness.pi, {
    getReport: report,
    refresh: async () => 'minted a 292-char state',
    forget: () => 'Dropped the stored turn state; the next request mints a new one.',
    ...overrides,
  })

  return harness
}

async function run(harness: ReturnType<typeof createHarness>, args: string): Promise<void> {
  await harness.commands.get('codex-enhancer')?.handler(args, harness.context)
}

describe('registerEnhancerCommand', () => {
  it('prints the ticket, the config and the paths', async () => {
    const harness = register()
    await run(harness, '')
    expect(harness.ui.notifications.at(-1)?.message).toContain('/agent/tickets.json')
  })

  it('mints on demand when asked to refresh', async () => {
    const harness = register()
    await run(harness, ' Refresh ')
    expect(harness.ui.notifications.at(-1)?.message).toBe('minted a 292-char state')
  })

  it('drops the stored state when asked to forget', async () => {
    const harness = register()
    await run(harness, 'forget')
    expect(harness.ui.notifications.at(-1)?.message).toContain('Dropped')
  })

  it('warns on an unknown subcommand instead of doing something', async () => {
    const harness = register()
    await run(harness, 'nuke')
    expect(harness.ui.notifications.at(-1)?.type).toBe('warning')
    expect(harness.ui.notifications.at(-1)?.message).toContain('Usage')
  })

  it('completes only the subcommands that match', () => {
    const harness = register()
    const completions = harness.commands.get('codex-enhancer')?.getArgumentCompletions?.('ref')
    expect(completions).toEqual([
      { value: 'refresh', label: 'refresh', description: 'Mint a new turn state now, ignoring the probe interval' },
    ])
  })

  it('offers no completions for a prefix nothing matches', () => {
    const harness = register()
    expect(harness.commands.get('codex-enhancer')?.getArgumentCompletions?.('zzz')).toBeNull()
  })

  it("survives a name clash with another extension's command", () => {
    const pi = {
      on: () => {},
      registerCommand: () => {
        throw new Error('already registered')
      },
    } as unknown as ExtensionAPI
    expect(() =>
      registerEnhancerCommand(pi, { getReport: report, refresh: async () => '', forget: () => '' }),
    ).not.toThrow()
  })
})
