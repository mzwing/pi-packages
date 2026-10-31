import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'

/**
 * Provider id → model id → the field names the user hand-wrote. Every definition is recorded, even one with no
 * tracked field, because models.json defining a provider's models already rules out completing it lazily.
 */
export type UserAuthoredMap = Map<string, Map<string, Set<string>>>

/** Only the fields this extension would otherwise overwrite. */
const TRACKED_FIELDS = new Set(['name', 'reasoning', 'input', 'cost', 'contextWindow', 'maxTokens', 'thinkingLevelMap'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Answers what the registry cannot: whether a value was hand-written or is Pi's placeholder. Pi reports a missing
 * or malformed models.json itself, so either reads as authoring nothing.
 */
export function readUserAuthoredFields(): UserAuthoredMap {
  const authored: UserAuthoredMap = new Map()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(getAgentDir(), 'models.json'), 'utf8'))
  } catch {
    return authored
  }
  if (!isRecord(parsed) || !isRecord(parsed['providers'])) {
    return authored
  }

  for (const [providerId, provider] of Object.entries(parsed['providers'])) {
    const definitions: unknown[] = isRecord(provider) && Array.isArray(provider['models']) ? provider['models'] : []
    const models = new Map<string, Set<string>>()
    for (const definition of definitions) {
      if (isRecord(definition) && typeof definition['id'] === 'string') {
        models.set(definition['id'], new Set(Object.keys(definition).filter(key => TRACKED_FIELDS.has(key))))
      }
    }
    if (models.size > 0) {
      authored.set(providerId, models)
    }
  }

  return authored
}
