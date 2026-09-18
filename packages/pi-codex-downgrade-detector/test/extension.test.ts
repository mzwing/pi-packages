import type { DetectorConfig, LoadConfigResult } from '../src/config.js'
import type { Harness } from './helpers.js'
import { describe, expect, it } from 'vitest'
import { COMMAND_NAME, DEFAULT_CONFIG } from '../src/config.js'
import { createDetectorExtension } from '../src/extension.js'
import { assistantMessage, createHarness, createRegistry } from './helpers.js'

function loadResult(overrides: Partial<DetectorConfig> = {}): LoadConfigResult {
  return {
    config: { ...DEFAULT_CONFIG, ...overrides },
    issues: [],
    globalPath: '/agent/extensions/pi-codex-downgrade-detector/config.json',
    projectPath: '/workspace/.pi/extensions/pi-codex-downgrade-detector/config.json',
  }
}

interface StartOptions {
  config?: Partial<DetectorConfig>
  models?: { id: string; provider: string; thinkingLevelMap?: Record<string, string | null> }[]
}

function start(options: StartOptions = {}): Harness {
  const harness = createHarness(createRegistry(options.models ?? [{ id: 'gpt-6-astra', provider: 'openai-codex' }]))
  createDetectorExtension(harness.pi, { loadConfig: () => loadResult(options.config), agentDir: '/agent' })
  harness.emit('session_start', {})

  return harness
}

function respond(harness: Harness, headers: Record<string, string>, message: Record<string, unknown>): void {
  harness.emit('before_provider_request', { payload: { model: 'gpt-6-astra' } })
  harness.emit('after_provider_response', { status: 200, headers })
  harness.emit('message_end', { message })
}

describe('createDetectorExtension', () => {
  it('shows the served model in the footer on a clean turn', () => {
    const harness = start()
    respond(harness, { 'openai-model': 'gpt-6-astra' }, assistantMessage())

    expect(harness.ui.statuses.at(-1)).toBe('✓ codex gpt-6-astra')
    expect(harness.ui.notifications).toEqual([])
  })

  it('notifies once per requested-to-served pair, not once per turn', () => {
    const harness = start()
    respond(harness, { 'openai-model': 'gpt-5.6-luna' }, assistantMessage())
    respond(harness, { 'openai-model': 'gpt-5.6-luna' }, assistantMessage())

    expect(harness.ui.statuses.at(-1)).toBe('↓ codex gpt-6-astra→gpt-5.6-luna')
    expect(harness.ui.notifications).toHaveLength(1)
    expect(harness.ui.notifications[0]).toMatchObject({ type: 'error' })
  })

  it('notifies on an upgrade too, because it is still not what was selected', () => {
    const harness = start()
    respond(harness, { 'openai-model': 'gpt-6-astra' }, assistantMessage({ model: 'gpt-5.4' }))

    expect(harness.ui.statuses.at(-1)).toBe('↑ codex gpt-5.4→gpt-6-astra')
    expect(harness.ui.notifications).toHaveLength(1)
  })

  it('stays silent when notify is off', () => {
    const harness = start({ config: { notify: false } })
    respond(harness, { 'openai-model': 'gpt-5.6-luna' }, assistantMessage())

    expect(harness.ui.notifications).toEqual([])
    expect(harness.ui.statuses.at(-1)).toBe('↓ codex gpt-6-astra→gpt-5.6-luna')
  })

  it('ignores providers it does not watch', () => {
    const harness = start()
    respond(harness, { 'openai-model': 'claude-haiku-5' }, assistantMessage({ provider: 'anthropic' }))

    expect(harness.ui.statuses).toEqual([undefined])
  })

  it('watches every provider when the list is empty', () => {
    const harness = start({ config: { providers: [] } })
    respond(harness, { 'openai-model': 'gpt-6-astra' }, assistantMessage({ provider: 'my-relay' }))

    expect(harness.ui.statuses.at(-1)).toBe('✓ codex gpt-6-astra')
  })

  it('reports unverified when the transport exposes no routing header', () => {
    const harness = start()
    respond(harness, {}, assistantMessage())

    expect(harness.ui.statuses.at(-1)).toBe('? codex gpt-6-astra unverified')
  })

  it("does not reuse one turn's headers for the next turn", () => {
    const harness = start()
    respond(harness, { 'openai-model': 'gpt-6-astra' }, assistantMessage())
    harness.emit('message_end', { message: assistantMessage() })

    expect(harness.ui.statuses.at(-1)).toBe('? codex gpt-6-astra unverified')
  })

  it('compares the sent effort against what the model maps the selected level to', () => {
    const harness = start({
      models: [{ id: 'gpt-6-astra', provider: 'openai-codex', thinkingLevelMap: { xhigh: 'high' } }],
    })
    harness.context.thinkingLevel = 'xhigh'

    harness.emit('before_provider_request', { payload: { reasoning: { effort: 'medium' } } })
    harness.emit('after_provider_response', { status: 200, headers: { 'openai-model': 'gpt-6-astra' } })
    harness.emit('message_end', { message: assistantMessage() })

    expect(harness.ui.statuses.at(-1)).toBe('⚠ codex gpt-6-astra · high→medium')
  })

  it('accepts the effort a model declares for that level', () => {
    const harness = start({
      models: [{ id: 'gpt-6-astra', provider: 'openai-codex', thinkingLevelMap: { xhigh: 'high' } }],
    })
    harness.context.thinkingLevel = 'xhigh'

    harness.emit('before_provider_request', { payload: { reasoning: { effort: 'high' } } })
    harness.emit('after_provider_response', { status: 200, headers: { 'openai-model': 'gpt-6-astra' } })
    harness.emit('message_end', { message: assistantMessage() })

    expect(harness.ui.statuses.at(-1)).toBe('✓ codex gpt-6-astra')
  })

  it('skips the effort axis when checkEffort is off', () => {
    const harness = start({ config: { checkEffort: false } })
    harness.context.thinkingLevel = 'xhigh'

    harness.emit('before_provider_request', { payload: { reasoning: { effort: 'medium' } } })
    harness.emit('after_provider_response', { status: 200, headers: { 'openai-model': 'gpt-6-astra' } })
    harness.emit('message_end', { message: assistantMessage() })

    expect(harness.ui.statuses.at(-1)).toBe('✓ codex gpt-6-astra')
  })

  it('treats a slug the registry offers as recorded', () => {
    const harness = start({
      models: [
        { id: 'gpt-6-astra', provider: 'openai-codex' },
        { id: 'codex-auto-review', provider: 'openai-codex' },
      ],
    })
    respond(harness, { 'openai-model': 'codex-auto-review' }, assistantMessage({ model: 'codex-auto-review' }))

    expect(harness.ui.statuses.at(-1)).toBe('✓ codex codex-auto-review')
  })

  it('clears the footer on shutdown', () => {
    const harness = start()
    respond(harness, { 'openai-model': 'gpt-6-astra' }, assistantMessage())
    harness.emit('session_shutdown', {})

    expect(harness.ui.statuses.at(-1)).toBeUndefined()
  })

  it('registers the command and reports the session', async () => {
    const harness = start()
    respond(harness, { 'openai-model': 'gpt-5.6-luna' }, assistantMessage())

    const command = harness.commands.get(COMMAND_NAME)
    expect(command).toBeDefined()

    await command!.handler('', harness.context)
    expect(harness.ui.notifications.at(-1)?.message).toContain('MODEL_SUBSTITUTED')

    await command!.handler('show', harness.context)
    expect(harness.ui.notifications.at(-1)?.message).toContain('providers   : openai-codex')

    await command!.handler('nonsense', harness.context)
    expect(harness.ui.notifications.at(-1)).toMatchObject({ type: 'warning' })
  })
})
