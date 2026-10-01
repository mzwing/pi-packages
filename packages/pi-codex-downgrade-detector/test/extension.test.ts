import type { DetectorConfig } from '../src/config.js'
import type { Harness, RegistryModel } from './helpers.js'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { configPaths } from '../src/config.js'
import { assistantMessage, createHarness, createRegistry, useWorkspace, writeFile } from './helpers.js'

describe('codex downgrade detector', () => {
  const workspace = useWorkspace()

  function start(config?: Partial<DetectorConfig>, models?: RegistryModel[]): Harness {
    if (config !== undefined) {
      writeFile(configPaths(workspace.cwd).global, config)
    }
    const harness = createHarness(
      workspace.cwd,
      createRegistry(models ?? [{ id: 'gpt-6-astra', provider: 'openai-codex' }]),
    )
    harness.emit('session_start', {})

    return harness
  }

  function respond(
    harness: Harness,
    headers: Record<string, string>,
    message: AssistantMessage,
    payload: unknown = { model: 'gpt-6-astra' },
  ): void {
    harness.emit('before_provider_request', { payload })
    harness.emit('after_provider_response', { status: 200, headers })
    harness.emit('message_end', { message })
  }

  // Every extension's status shares one hard-truncated footer line, so the slugs live in a widget row instead.
  it('keeps the footer to one glyph and shows a widget row only while a turn diverges', () => {
    const harness = start()
    expect(harness.ui.statuses).toEqual(['· codex'])

    respond(harness, { 'openai-model': 'gpt-5.6-luna' }, assistantMessage())
    expect(harness.ui.statuses.at(-1)).toBe('↓ codex')
    expect(harness.ui.widgets.at(-1)).toEqual(['↓ codex gpt-6-astra→gpt-5.6-luna (openai-model header)'])

    respond(harness, { 'openai-model': 'gpt-6-astra' }, assistantMessage())
    expect(harness.ui.statuses.at(-1)).toBe('✓ codex')
    expect(harness.ui.widgets.at(-1)).toBeUndefined()
  })

  it('notifies once per requested-to-served pair, not once per turn', () => {
    const harness = start()
    respond(harness, { 'openai-model': 'gpt-5.6-luna' }, assistantMessage())
    respond(harness, { 'openai-model': 'gpt-5.6-luna' }, assistantMessage())

    expect(harness.ui.notifications).toEqual([{ message: 'codex-downgrade: gpt-6-astra→gpt-5.6-luna', type: 'error' }])
  })

  it('notifies on an upgrade too, because it is still not what was selected', () => {
    const harness = start()
    respond(harness, { 'openai-model': 'gpt-6-astra' }, assistantMessage({ model: 'gpt-5.4' }))

    expect(harness.ui.statuses.at(-1)).toBe('↑ codex')
    expect(harness.ui.notifications).toHaveLength(1)
  })

  it("reports silence as silence, and never confirms a turn with the previous turn's headers", () => {
    const harness = start()
    respond(harness, { 'openai-model': 'gpt-6-astra' }, assistantMessage())
    harness.emit('message_end', { message: assistantMessage() })

    expect(harness.ui.statuses.at(-1)).toBe('? codex')
    expect(harness.ui.widgets.at(-1)).toBeUndefined()
    expect(harness.ui.notifications).toEqual([])
  })

  it("trusts the server-stated header over the relay's echoed model, and names which one it used", () => {
    const harness = start()
    respond(harness, { 'X-OpenAI-Model': 'gpt-6-astra' }, assistantMessage({ responseModel: 'gpt-5.6-luna' }))
    expect(harness.ui.statuses.at(-1)).toBe('✓ codex')

    respond(harness, {}, assistantMessage({ responseModel: 'gpt-5.6-luna' }))
    expect(harness.ui.widgets.at(-1)).toEqual(['↓ codex gpt-6-astra→gpt-5.6-luna (response model field)'])
  })

  it('compares the effort sent, in either wire spelling, with what the model maps the selected level to', () => {
    const harness = start(undefined, [
      { id: 'gpt-6-astra', provider: 'openai-codex', thinkingLevelMap: { xhigh: 'high' } },
    ])
    respond(harness, { 'openai-model': 'gpt-6-astra' }, assistantMessage({ thinkingLevel: 'xhigh' }), {
      reasoning_effort: 'medium',
    })
    expect(harness.ui.widgets.at(-1)).toEqual(['⚠ codex gpt-6-astra · high→medium (openai-model header)'])

    respond(harness, { 'openai-model': 'gpt-6-astra' }, assistantMessage({ thinkingLevel: 'xhigh' }), {
      reasoning: { effort: 'high' },
    })
    expect(harness.ui.statuses.at(-1)).toBe('✓ codex')
  })

  it('has nothing to compare when the model marks the selected level unsupported', () => {
    const harness = start(undefined, [
      { id: 'gpt-6-astra', provider: 'openai-codex', thinkingLevelMap: { xhigh: null } },
    ])
    respond(harness, { 'openai-model': 'gpt-6-astra' }, assistantMessage({ thinkingLevel: 'xhigh' }), {
      reasoning: { effort: 'high' },
    })

    expect(harness.ui.statuses.at(-1)).toBe('✓ codex')
  })

  // A virtual model keeps the selection in the context while its router sends another level.
  it('judges the level a turn went out at, not the one selected', () => {
    const harness = start()
    harness.context.thinkingLevel = 'high'
    respond(harness, { 'openai-model': 'gpt-6-astra' }, assistantMessage({ thinkingLevel: 'medium' }), {
      reasoning: { effort: 'medium' },
    })

    expect(harness.ui.statuses.at(-1)).toBe('✓ codex')
  })

  it('treats a slug the registry offers as recorded, so a relay-added model is not a stranger', () => {
    const harness = start(undefined, [
      { id: 'gpt-6-astra', provider: 'openai-codex' },
      { id: 'codex-auto-review', provider: 'openai-codex' },
    ])
    respond(harness, { 'openai-model': 'codex-auto-review' }, assistantMessage({ model: 'codex-auto-review' }))

    expect(harness.ui.statuses.at(-1)).toBe('✓ codex')
  })

  it('ignores a turn a virtual model failed to route, which no provider ever saw', () => {
    const harness = start()
    respond(harness, {}, assistantMessage({ model: 'auto', api: 'pi-virtual' }))

    expect(harness.ui.statuses).toEqual(['· codex'])
  })
})
