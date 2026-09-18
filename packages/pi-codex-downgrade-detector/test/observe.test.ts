import { describe, expect, it } from 'vitest'
import {
  backendFamily,
  buildTurnObservation,
  observeAssistantMessage,
  observeRequestPayload,
  observeResponseHeaders,
} from '../src/observe.js'
import { assistantMessage } from './helpers.js'

describe('observeResponseHeaders', () => {
  it('reads the served model and the faster-fallback pair', () => {
    const observation = observeResponseHeaders(200, {
      'openai-model': 'gpt-5.6-luna',
      'x-codex-safety-buffering-faster-model': 'gpt-5.6-luna',
      'x-codex-safety-buffering-enabled': 'false',
    })

    expect(observation).toMatchObject({
      status: 200,
      servedModel: 'gpt-5.6-luna',
      fasterFallbackModel: 'gpt-5.6-luna',
      bufferingEnabled: 'false',
      sawRoutingHeaders: true,
    })
  })

  it('accepts the x-openai-model spelling and any header casing', () => {
    expect(observeResponseHeaders(200, { 'X-OpenAI-Model': 'gpt-6-astra' }).servedModel).toBe('gpt-6-astra')
  })

  it('treats a blank header value as absent', () => {
    expect(observeResponseHeaders(200, { 'openai-model': '   ' }).servedModel).toBeUndefined()
  })

  it('reports a response with no routing headers at all', () => {
    expect(observeResponseHeaders(500, { 'content-type': 'application/json' })).toMatchObject({
      servedModel: undefined,
      sawRoutingHeaders: false,
    })
  })
})

describe('observeRequestPayload', () => {
  it('reads the responses-API reasoning effort', () => {
    expect(observeRequestPayload({ model: 'gpt-6-astra', reasoning: { effort: 'xhigh' } })).toBe('xhigh')
  })

  it('reads the completions-API spelling', () => {
    expect(observeRequestPayload({ reasoning_effort: 'high' })).toBe('high')
  })

  it('returns undefined for a payload that carries no effort', () => {
    expect(observeRequestPayload({ model: 'gpt-6-astra' })).toBeUndefined()
    expect(observeRequestPayload('not an object')).toBeUndefined()
    expect(observeRequestPayload(null)).toBeUndefined()
  })
})

describe('backendFamily', () => {
  it('fingerprints the upstream from the id shape', () => {
    expect(backendFamily('resp_abc')).toBe('openai-responses')
    expect(backendFamily('chatcmpl-abc')).toBe('openai-chat-completions')
    expect(backendFamily('msg_01abc')).toBe('anthropic-messages')
    expect(backendFamily('msg_abc')).toBe('openai-or-anthropic-message-item')
    expect(backendFamily('gen-abc')).toBe('openrouter')
    expect(backendFamily('whatever')).toBe('unrecognized')
    expect(backendFamily(undefined)).toBe('unknown')
  })
})

describe('observeAssistantMessage', () => {
  it('narrows an assistant message to the fields the check reads', () => {
    expect(observeAssistantMessage(assistantMessage({ responseModel: 'gpt-5.6-luna', responseId: 'resp_1' }))).toEqual({
      provider: 'openai-codex',
      requestedModel: 'gpt-6-astra',
      responseModel: 'gpt-5.6-luna',
      responseId: 'resp_1',
    })
  })

  it('ignores anything that is not an assistant message', () => {
    expect(observeAssistantMessage({ role: 'user', content: 'hi' })).toBeUndefined()
    expect(observeAssistantMessage(undefined)).toBeUndefined()
  })

  it('ignores an assistant message with no provider or model to compare', () => {
    expect(observeAssistantMessage({ role: 'assistant', provider: 'openai-codex' })).toBeUndefined()
  })
})

describe('buildTurnObservation', () => {
  const assistant = {
    provider: 'openai-codex',
    requestedModel: 'gpt-6-astra',
    responseModel: 'gpt-5.5',
    responseId: 'resp_1',
  }

  it('prefers the server-stated header over the response model field', () => {
    const turn = buildTurnObservation({
      assistant,
      headers: observeResponseHeaders(200, { 'openai-model': 'gpt-5.6-luna' }),
    })

    expect(turn).toMatchObject({ servedModel: 'gpt-5.6-luna', servedModelSource: 'header' })
  })

  it('falls back to the response model field when no header arrived', () => {
    const turn = buildTurnObservation({ assistant, headers: observeResponseHeaders(200, {}) })

    expect(turn).toMatchObject({ servedModel: 'gpt-5.5', servedModelSource: 'responseModel' })
  })

  it('records no source when neither signal is present', () => {
    const turn = buildTurnObservation({ assistant: { ...assistant, responseModel: undefined } })

    expect(turn).toMatchObject({
      servedModel: undefined,
      servedModelSource: undefined,
      backendFamily: 'openai-responses',
    })
  })
})
