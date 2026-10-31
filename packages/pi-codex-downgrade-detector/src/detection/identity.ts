/** A convenience, never the source of truth: an unranked slug is unrecorded, never fine. */
const MODEL_TIERS: Record<string, number> = {
  'gpt-6-astra': 100,
  'gpt-6.1-sol': 96,
  'gpt-6-sol': 94,
  'gpt-5.6-sol': 90,
  'gpt-5.6-terra': 65,
  'gpt-5.5': 60,
  'gpt-6-luna': 42,
  'gpt-5.6-luna': 40,
  'gpt-5.4': 38,
  'gpt-5.4-mini': 25,
  'gpt-5.3-codex-spark': 20,
  'gpt-5.2': 15,
}

const OPENAI_PREFIXES = [
  'gpt-',
  'gpt3',
  'gpt4',
  'gpt5',
  'gpt6',
  'chatgpt',
  'codex',
  'o1-',
  'o3-',
  'o4-',
  'text-davinci',
  'davinci',
  'babbage',
]

/** Smallest first. The class orders two OpenAI slugs before their version does. */
const OPENAI_CLASSES = ['luna', 'terra', 'sol', 'astra']

const SMALL_MODEL_MARKERS = new Set([
  'mini',
  'nano',
  'small',
  'tiny',
  'micro',
  'lite',
  'light',
  'flash',
  'air',
  'spark',
  'turbo',
  'fast',
  'instant',
  'haiku',
])

const LARGE_MODEL_MARKERS = new Set(['pro', 'max', 'ultra', 'opus', 'large', 'heavy', 'xl'])

// '5.6' -> [5, 6]; '4o' -> [4] plus a trailing variant token 'o'.
const VERSION_TOKEN = /^v?(\d+(?:\.\d+)*)([a-z]*)$/
const SLUG_SPLIT = /[-_/:\s]+/

export interface ModelIdentity {
  /** Trimmed and lowercased slug. */
  key: string
  vendor: 'openai' | 'other'
  family: string | undefined
  version: number[]
  variant: string | undefined
  sizeMarker: string | undefined
  largeMarker: string | undefined
  /** Index into `OPENAI_CLASSES`. */
  classRank: number | undefined
  known: boolean
  /** The recorded slug this one is, or extends with a server-side suffix. */
  base: string | undefined
  tier: number | undefined
}

export type IdentifyModel = (slug: string) => ModelIdentity

type SlugShape = Pick<
  ModelIdentity,
  'vendor' | 'family' | 'version' | 'variant' | 'sizeMarker' | 'largeMarker' | 'classRank'
>

/** 'gpt-5.7-mini' parses as openai, family gpt, version [5, 7], marker 'mini' without being recorded anywhere. */
function parseSlug(slug: string): SlugShape {
  const vendor = OPENAI_PREFIXES.some(prefix => slug.startsWith(prefix)) ? 'openai' : 'other'
  const [family, ...rest] = slug.split(SLUG_SPLIT).filter(token => token.length > 0)
  const versionAt = rest.findIndex(token => VERSION_TOKEN.test(token))
  const [, digits, suffix] = VERSION_TOKEN.exec(rest[versionAt] ?? '') ?? []
  const tail = versionAt < 0 ? rest : [suffix ?? '', ...rest.slice(versionAt + 1)].filter(token => token !== '')
  const openaiClass = vendor === 'openai' ? rest.find(token => OPENAI_CLASSES.includes(token)) : undefined

  return {
    vendor,
    family,
    version: digits === undefined ? [] : digits.split('.').map(Number),
    variant: tail.length > 0 ? tail.join('-') : undefined,
    // Markers sit mid-slug too ('claude-opus-5'), not only in the tail.
    sizeMarker: rest.find(token => SMALL_MODEL_MARKERS.has(token)),
    largeMarker: rest.find(token => LARGE_MODEL_MARKERS.has(token)),
    classRank: openaiClass === undefined ? undefined : OPENAI_CLASSES.indexOf(openaiClass),
  }
}

/** Negative when `left` is older, positive when newer, zero when equal. */
export function compareVersions(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) {
      return difference
    }
  }

  return 0
}

/**
 * Resolves a slug against the configured ranks, the built-in table and the slugs Pi's registry offers,
 * then falls back to its shape, so an unrecorded model is still judged rather than waved through.
 */
export function createIdentityResolver(tiers: Record<string, number>, registrySlugs: readonly string[]): IdentifyModel {
  const ranks = new Map(Object.entries({ ...MODEL_TIERS, ...tiers }))
  const recorded = new Set([...ranks.keys(), ...registrySlugs.map(slug => slug.trim().toLowerCase())])
  const longestFirst = [...recorded].sort((left, right) => right.length - left.length)

  return slug => {
    const key = slug.trim().toLowerCase()
    const base = recorded.has(key)
      ? key
      : longestFirst.find(candidate => key.startsWith(`${candidate}-`) || key.startsWith(`${candidate}_`))

    return {
      ...parseSlug(base ?? key),
      key,
      known: base !== undefined,
      base,
      tier: ranks.get(key) ?? (base === undefined ? undefined : ranks.get(base)),
    }
  }
}
