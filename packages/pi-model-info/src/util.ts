import { EXTENSION_ID } from './config.js'

/** Drops undefined values, so `exactOptionalPropertyTypes` sees omission rather than an undefined slot. */
export function compact<T extends object>(value: { [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function warn(message: string): void {
  console.warn(`[${EXTENSION_ID}] ${message}`)
}
