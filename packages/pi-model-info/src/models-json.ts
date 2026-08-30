import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** provider id → model id → field names the user hand-wrote. */
export type UserAuthoredMap = Map<string, Map<string, Set<string>>>

/** Only fields this extension would otherwise overwrite are worth tracking. */
const TRACKED_FIELDS = new Set(['name', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens', 'thinkingLevelMap'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function defaultRead(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Answers what the registry cannot: whether a value was hand-written or is Pi's placeholder.
 * Without it, a user who wrote `contextWindow: 200000` would silently get the catalog's number.
 */
export function readUserAuthoredFields(
  agentDir: string,
  readFile: (path: string) => string | undefined = defaultRead,
): UserAuthoredMap {
  const authored: UserAuthoredMap = new Map()

  let raw: string | undefined
  try {
    raw = readFile(join(agentDir, 'models.json'))
  } catch {
    return authored
  }
  if (raw === undefined) {
    return authored
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return authored
  }
  if (!isRecord(parsed) || !isRecord(parsed['providers'])) {
    return authored
  }

  for (const [providerId, provider] of Object.entries(parsed['providers'])) {
    if (!isRecord(provider) || !Array.isArray(provider['models'])) {
      continue
    }
    const models = new Map<string, Set<string>>()
    for (const definition of provider['models']) {
      if (!isRecord(definition) || typeof definition['id'] !== 'string') {
        continue
      }
      const fields = new Set(Object.keys(definition).filter(key => TRACKED_FIELDS.has(key)))
      if (fields.size > 0) {
        models.set(definition['id'], fields)
      }
    }
    if (models.size > 0) {
      authored.set(providerId, models)
    }
  }

  return authored
}
