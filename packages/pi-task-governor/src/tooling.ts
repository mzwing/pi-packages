import type { Runtime } from './runtime.js'
import type { TString } from 'typebox'
import { Type } from 'typebox'

export interface Host {
  runtime: () => Runtime | undefined
  /** Called after every change to the store made from this session. */
  changed: () => void
}

export function textResult(text: string): { content: { type: 'text'; text: string }[]; details: undefined } {
  return { content: [{ type: 'text', text }], details: undefined }
}

export function nonBlank(description: string): TString {
  return Type.String({ pattern: '\\S', description })
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
