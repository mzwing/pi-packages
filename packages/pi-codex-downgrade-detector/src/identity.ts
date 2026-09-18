/**
 * Ranking of OpenAI first-party coding slugs. A convenience, never the source of truth:
 * anything missing is treated as unrecorded, never as fine.
 */
const MODEL_TIERS: Record<string, number> = {
  'gpt-6-astra': 100,
  'gpt-5.6-sol': 90,
  'gpt-5.6-terra': 65,
  'gpt-5.5': 60,
  'gpt-5.6-luna': 40,
  'gpt-5.4': 38,
  'gpt-5.4-mini': 25,
  'gpt-5.3-codex-spark': 20,
  'gpt-5.2': 15,
}

/** Only OpenAI slugs are named. Everything else is one bucket, reported by its raw id. */
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

/** Tokens marking a deliberately smaller or cheaper sibling. */
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

/** Tokens marking the larger sibling, so a bigger model is not called a downgrade. */
const LARGE_MODEL_MARKERS = new Set(['pro', 'max', 'ultra', 'opus', 'large', 'heavy', 'xl'])

// '5.6' -> [5, 6]; '4o' -> [4] plus a trailing variant token 'o'.
const VERSION_TOKEN = /^v?(\d+(?:\.\d+)*)([a-z]*)$/
const SLUG_SPLIT = /[-_/:\s]+/
const LEADING_SEPARATORS = /^[-_]+/

type IdentitySource = 'config' | 'builtin' | 'registry' | 'inferred'

export interface SlugShape {
  vendor: 'openai' | 'other' | undefined
  family: string | undefined
  line: string | undefined
  version: number[]
  variant: string | undefined
  sizeMarker: string | undefined
  largeMarker: string | undefined
}

export interface ModelIdentity extends SlugShape {
  slug: string
  normalized: string
  known: boolean
  source: IdentitySource
  /** Recorded slug this one extends, if any. */
  base: string | undefined
  /** Server-side suffix beyond that base. */
  suffix: string | undefined
  tier: number | undefined
  tierSource: 'config' | 'builtin' | undefined
}

export interface IdentityResolver {
  identify: (slug: string | undefined) => ModelIdentity | undefined
}

export interface IdentityResolverOptions {
  /** `slug -> rank` from user config, outranking the built-in table. */
  tiers?: Record<string, number> | undefined
  /** Slugs the provider can actually offer, from Pi's model registry. */
  registrySlugs?: readonly string[] | undefined
}

/**
 * Takes a model slug apart without needing it to be recorded anywhere, so an unrecorded model
 * stays comparable: 'gpt-5.7-mini' parses as openai, family gpt, version [5, 7], marker 'mini'.
 */
export function parseSlug(slug: string): SlugShape {
  const key = slug.trim().toLowerCase()
  const shape: SlugShape = {
    vendor: undefined,
    family: undefined,
    line: undefined,
    version: [],
    variant: undefined,
    sizeMarker: undefined,
    largeMarker: undefined,
  }
  if (key.length === 0) {
    return shape
  }

  shape.vendor = OPENAI_PREFIXES.some(prefix => key.startsWith(prefix)) ? 'openai' : 'other'

  const tokens = key.split(SLUG_SPLIT).filter(token => token.length > 0)
  const family = tokens[0]
  if (family === undefined) {
    return shape
  }
  shape.family = family

  let versionAt: number | undefined
  let versionSuffix = ''
  for (let index = 1; index < tokens.length; index += 1) {
    const match = VERSION_TOKEN.exec(tokens[index] ?? '')
    if (match?.[1] === undefined) {
      continue
    }
    shape.version = match[1].split('.').map(Number)
    versionSuffix = match[2] ?? ''
    versionAt = index
    break
  }

  const tail =
    versionAt === undefined
      ? tokens.slice(1)
      : [...(versionSuffix.length > 0 ? [versionSuffix] : []), ...tokens.slice(versionAt + 1)]
  shape.line = (versionAt === undefined ? tokens : tokens.slice(0, versionAt)).join('-')
  shape.variant = tail.length > 0 ? tail.join('-') : undefined

  // Every token after the family name: size markers live in the tail ('gpt-5.4-mini')
  // but also mid-slug ('claude-opus-5').
  for (const token of tokens.slice(1)) {
    if (shape.sizeMarker === undefined && SMALL_MODEL_MARKERS.has(token)) {
      shape.sizeMarker = token
    }
    if (shape.largeMarker === undefined && LARGE_MODEL_MARKERS.has(token)) {
      shape.largeMarker = token
    }
  }

  return shape
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

/** Short provenance string, quoted inside finding messages. */
export function describeIdentity(identity: ModelIdentity): string {
  if (identity.tier !== undefined) {
    return `ranked ${identity.tier} in the ${identity.tierSource === 'config' ? 'configured' : 'built-in'} tier table`
  }
  if (identity.source === 'registry') {
    return 'offered by this provider but ranked nowhere'
  }
  const bits = identity.vendor === 'openai' ? [] : ['not an OpenAI slug']
  if (identity.version.length > 0) {
    bits.push(`v${identity.version.join('.')}`)
  }
  if (identity.sizeMarker !== undefined) {
    bits.push(`'${identity.sizeMarker}' size marker`)
  }

  return `unrecorded, inferred from the slug (${bits.length > 0 ? bits.join(', ') : 'shape only'})`
}

/**
 * Resolves 'what is this slug?' from the configured ranks, the built-in table, then the slugs
 * Pi's registry says the provider offers, then structural inference — so an unrecorded model is
 * judged rather than waved through.
 */
export function createIdentityResolver(options: IdentityResolverOptions = {}): IdentityResolver {
  const configTiers = options.tiers ?? {}
  const registrySlugs = new Set((options.registrySlugs ?? []).map(slug => slug.trim().toLowerCase()))
  const recorded = [...new Set([...Object.keys(configTiers), ...Object.keys(MODEL_TIERS), ...registrySlugs])].sort(
    (a, b) => b.length - a.length,
  )
  const cache = new Map<string, ModelIdentity>()

  function sourceOf(slug: string): IdentitySource | undefined {
    if (configTiers[slug] !== undefined) {
      return 'config'
    }
    if (MODEL_TIERS[slug] !== undefined) {
      return 'builtin'
    }

    return registrySlugs.has(slug) ? 'registry' : undefined
  }

  /** Exact match first, then longest recorded prefix, so a server-side suffix still resolves. */
  function matchRecorded(key: string): string | undefined {
    if (sourceOf(key) !== undefined) {
      return key
    }

    return recorded.find(base => key.startsWith(base) && key.length > base.length && '-_'.includes(key[base.length]!))
  }

  function lookupTier(key: string, base: string | undefined): Pick<ModelIdentity, 'tier' | 'tierSource'> {
    for (const candidate of base === undefined || base === key ? [key] : [key, base]) {
      const configured = configTiers[candidate]
      if (configured !== undefined) {
        return { tier: configured, tierSource: 'config' }
      }
      const builtin = MODEL_TIERS[candidate]
      if (builtin !== undefined) {
        return { tier: builtin, tierSource: 'builtin' }
      }
    }

    return { tier: undefined, tierSource: undefined }
  }

  function identify(slug: string | undefined): ModelIdentity | undefined {
    if (slug === undefined || slug.trim().length === 0) {
      return undefined
    }
    const key = slug.trim().toLowerCase()
    const cached = cache.get(key)
    if (cached !== undefined) {
      return cached
    }

    const base = matchRecorded(key)
    const shape = parseSlug(base ?? key)
    const identity: ModelIdentity = {
      ...shape,
      ...lookupTier(key, base),
      slug: slug.trim(),
      normalized: key,
      known: base !== undefined,
      source: (base === undefined ? undefined : sourceOf(base)) ?? 'inferred',
      base,
      suffix:
        base !== undefined && key.length > base.length
          ? key.slice(base.length).replace(LEADING_SEPARATORS, '')
          : undefined,
    }
    cache.set(key, identity)

    return identity
  }

  return { identify }
}
