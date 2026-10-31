import type { AssistantMessage } from '@earendil-works/pi-ai'

/** The response headers Codex itself reads. */
const SERVED_MODEL_HEADERS = ['openai-model', 'x-openai-model']
const FASTER_MODEL_HEADER = 'x-codex-safety-buffering-faster-model'
const ROUTING_HEADERS = [
  ...SERVED_MODEL_HEADERS,
  FASTER_MODEL_HEADER,
  'x-codex-safety-buffering-enabled',
  'x-request-id',
]

export interface HeaderObservation {
  servedModel: string | undefined
  fasterFallbackModel: string | undefined
  sawRoutingHeaders: boolean
}

export interface TurnObservation {
  requestedModel: string
  servedModel: string | undefined
  servedModelSource: 'header' | 'responseModel' | undefined
  fasterFallbackModel: string | undefined
  sawRoutingHeaders: boolean
  responseId: string | undefined
  /** The Pi thinking level the turn went out at, which a virtual model's router may have picked. */
  selectedEffort: string | undefined
  /** What that level maps to for this model, which is what Pi should have sent. */
  expectedEffort: string | undefined
  sentEffort: string | undefined
}

export interface TurnInput {
  message: AssistantMessage
  headers: HeaderObservation | undefined
  sentEffort: string | undefined
  expectedEffort: string | undefined
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** Only providers that build the record from a `Headers` object lowercase the names. */
export function observeHeaders(headers: Record<string, string>): HeaderObservation {
  const byName = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))

  return {
    servedModel: SERVED_MODEL_HEADERS.map(name => nonBlank(byName.get(name))).find(value => value !== undefined),
    fasterFallbackModel: nonBlank(byName.get(FASTER_MODEL_HEADER)),
    sawRoutingHeaders: ROUTING_HEADERS.some(name => byName.has(name)),
  }
}

export function observeSentEffort(payload: unknown): string | undefined {
  const request = payload as { reasoning?: { effort?: unknown }; reasoning_effort?: unknown } | null | undefined

  return nonBlank(request?.reasoning?.effort) ?? nonBlank(request?.reasoning_effort)
}

/** The header is server-stated and wins; `responseModel` covers a completions-style relay that drops it. */
export function observeTurn({ message, headers, sentEffort, expectedEffort }: TurnInput): TurnObservation {
  const servedModel = headers?.servedModel ?? message.responseModel

  return {
    requestedModel: message.model,
    servedModel,
    servedModelSource:
      headers?.servedModel !== undefined ? 'header' : servedModel === undefined ? undefined : 'responseModel',
    fasterFallbackModel: headers?.fasterFallbackModel,
    sawRoutingHeaders: headers?.sawRoutingHeaders ?? false,
    responseId: message.responseId,
    selectedEffort: message.thinkingLevel,
    expectedEffort,
    sentEffort,
  }
}
