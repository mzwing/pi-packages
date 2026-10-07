import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { getAgentDir } from '@earendil-works/pi-coding-agent'

const EXTENSION_ID = 'pi-session-hub'

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export function hubPath(...segments: string[]): string {
  return join(getAgentDir(), EXTENSION_ID, ...segments)
}

/** The rename is atomic, so a reader never sees half a file. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value))
  renameSync(temporary, path)
}

/** `undefined` when the file is gone: its writer may remove it between a listing and the read. */
export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch (error) {
    if (isMissing(error)) {
      return undefined
    }
    throw error
  }
}

export function listJsonFiles(directory: string): string[] {
  try {
    return readdirSync(directory)
      .filter(name => name.endsWith('.json'))
      .sort()
  } catch (error) {
    if (isMissing(error)) {
      return []
    }
    throw error
  }
}
