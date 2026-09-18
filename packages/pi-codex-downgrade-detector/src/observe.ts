/** Response headers Codex itself reads. Quota headers are deliberately not among them. */
const SERVED_MODEL_HEADERS = ['openai-model', 'x-openai-model']
const FASTER_MODEL_HEADER = 'x-codex-safety-buffering-faster-model'
const BUFFERING_ENABLED_HEADER = 'x-codex-safety-buffering-enabled'
const ROUTING_HEADERS = [...SERVED_MODEL_HEADERS, FASTER_MODEL_HEADER, BUFFERING_ENABLED_HEADER, 'x-request-id']

export type BackendFamily =
  | 'openai-responses'
  | 'openai-chat-completions'
  | 'anthropic-messages'
  | 'openai-or-anthropic-message-item'
  | 'openrouter'
  | 'unrecognized'
  | 'unknown'

export interface HeaderObservation {
  status: number | undefined
  servedModel: string | undefined
  fasterFallbackModel: string | undefined
  bufferingEnabled: string | undefined
  sawRoutingHeaders: boolean
}

export interface AssistantObservation {
  provider: string
  requestedModel: string
  responseModel: string | undefined
  responseId: string | undefined
}

export interface TurnObservation extends AssistantObservation {
  servedModel: string | undefined
  servedModelSource: 'header' | 'responseModel' | undefined
  fasterFallbackModel: string | undefined
  bufferingEnabled: string | undefined
  sawRoutingHeaders: boolean
  backendFamily: BackendFamily
  status: number | undefined
  /** The Pi thinking level in force for this turn. */
  selectedEffort: string | undefined
  /** What that level maps to for this model, which is what Pi should have sent. */
  expectedEffort: string | undefined
  /** What actually went on the wire. */
  sentEffort: string | undefined
}

export interface BuildTurnOptions {
  assistant: AssistantObservation
  headers?: HeaderObservation | undefined
  sentEffort?: string | undefined
  selectedEffort?: string | undefined
  expectedEffort?: string | undefined
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]

  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

export function observeResponseHeaders(status: number, headers: Record<string, string>): HeaderObservation {
  const normalized: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    normalized[name.toLowerCase()] = value
  }

  return {
    status,
    servedModel: SERVED_MODEL_HEADERS.map(name => readString(normalized, name)).find(value => value !== undefined),
    fasterFallbackModel: readString(normalized, FASTER_MODEL_HEADER),
    bufferingEnabled: readString(normalized, BUFFERING_ENABLED_HEADER),
    sawRoutingHeaders: ROUTING_HEADERS.some(name => normalized[name] !== undefined),
  }
}

/** The effort that actually went on the wire, after Pi's thinking-level mapping. */
export function observeRequestPayload(payload: unknown): string | undefined {
  const record = asRecord(payload)
  if (record === undefined) {
    return undefined
  }

  return readString(asRecord(record['reasoning']) ?? {}, 'effort') ?? readString(record, 'reasoning_effort')
}

/**
 * Fingerprints the upstream vendor from the id shape. A relay that swaps the upstream provider
 * usually forgets to rewrite the id it returns.
 */
export function backendFamily(responseId: string | undefined): BackendFamily {
  if (responseId === undefined) {
    return 'unknown'
  }
  const id = responseId.trim()
  if (id.startsWith('resp_')) {
    return 'openai-responses'
  }
  if (id.startsWith('chatcmpl-')) {
    return 'openai-chat-completions'
  }
  if (id.startsWith('msg_01')) {
    return 'anthropic-messages'
  }
  if (id.startsWith('msg_')) {
    return 'openai-or-anthropic-message-item'
  }

  return id.startsWith('gen-') ? 'openrouter' : 'unrecognized'
}

/** Narrows a `message_end` payload to the assistant fields this extension reads. */
export function observeAssistantMessage(message: unknown): AssistantObservation | undefined {
  const record = asRecord(message)
  if (record === undefined || record['role'] !== 'assistant') {
    return undefined
  }
  const provider = readString(record, 'provider')
  const requestedModel = readString(record, 'model')
  if (provider === undefined || requestedModel === undefined) {
    return undefined
  }

  return {
    provider,
    requestedModel,
    responseModel: readString(record, 'responseModel'),
    responseId: readString(record, 'responseId'),
  }
}

/**
 * The header is server-stated and wins. `responseModel` is only populated on the completions
 * path, so it is the signal that covers a relay when no routing header survives.
 */
export function buildTurnObservation(options: BuildTurnOptions): TurnObservation {
  const { assistant, headers } = options
  const fromHeader = headers?.servedModel
  const servedModel = fromHeader ?? assistant.responseModel

  return {
    ...assistant,
    servedModel,
    servedModelSource: servedModel === undefined ? undefined : fromHeader !== undefined ? 'header' : 'responseModel',
    fasterFallbackModel: headers?.fasterFallbackModel,
    bufferingEnabled: headers?.bufferingEnabled,
    sawRoutingHeaders: headers?.sawRoutingHeaders ?? false,
    backendFamily: backendFamily(assistant.responseId),
    status: headers?.status,
    selectedEffort: options.selectedEffort,
    expectedEffort: options.expectedEffort,
    sentEffort: options.sentEffort,
  }
}
