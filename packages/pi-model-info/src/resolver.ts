import type {
  AffixRule,
  CatalogEntry,
  CatalogIndex,
  MatchKind,
  Resolution,
  ResolvedMatch,
  ResolvedProvider,
} from './types.js'
import { scopedKey } from './catalog-index.js'
import { bareId, vendorOf } from './catalog-sources.js'

export interface ResolveInput {
  index: CatalogIndex
  provider: ResolvedProvider
  prefixRules: AffixRule[]
  suffixRules: AffixRule[]
  modelId: string
}

interface Hit {
  entry: CatalogEntry
  /** Same-provider entry from another source, for structural backfill only. */
  donor: CatalogEntry | undefined
  viaVendorSplit: boolean
}

type Outcome = { hit: Hit } | { ambiguous: CatalogEntry[] } | undefined

interface KeyForm {
  scope: string | undefined
  id: string
  /** This form is scoped by the vendor parsed out of the requested id. */
  vendorScoped: boolean
  /** The vendor the request named, if any. */
  vendor: string | undefined
}

/**
 * Vendor qualification is a key form rather than an affix rule: relays overwhelmingly use
 * `vendor/model` ids, and spending the one-prefix budget on that would leave nothing for a real
 * prefix. The vendor-scoped form deliberately precedes the unscoped one, whose bare-id fallback can
 * return several providers — an explicit `anthropic/…` should settle that outright.
 */
function keyForms(provider: ResolvedProvider, id: string): KeyForm[] {
  const forms: KeyForm[] = []
  const vendor = vendorOf(id)
  const rest = bareId(id)

  if (provider.catalogProvider !== undefined) {
    forms.push({ scope: provider.catalogProvider, id, vendorScoped: false, vendor })
    if (vendor !== undefined) {
      forms.push({ scope: provider.catalogProvider, id: rest, vendorScoped: false, vendor })
    }
  }
  forms.push({ scope: provider.id, id, vendorScoped: false, vendor })
  if (vendor !== undefined) {
    forms.push({ scope: vendor, id: rest, vendorScoped: true, vendor })
  }
  forms.push({ scope: undefined, id, vendorScoped: false, vendor })

  return forms
}

interface Candidates {
  entries: CatalogEntry[]
  /** True when the verbatim id missed and the vendor-stripped id was used instead. */
  viaBare: boolean
}

function candidatesFor(index: CatalogIndex, form: KeyForm): Candidates {
  if (form.scope !== undefined) {
    return { entries: index.scoped.get(scopedKey(form.scope, form.id)) ?? [], viaBare: false }
  }
  const exact = index.exact.get(form.id.toLowerCase())
  if (exact !== undefined && exact.length > 0) {
    return { entries: exact, viaBare: false }
  }

  return { entries: index.bare.get(bareId(form.id).toLowerCase()) ?? [], viaBare: true }
}

/**
 * The tie-break selects a PROVIDER; insertion order (already source-ranked) then selects the entry.
 * Splicing fields from two providers would be incoherent — the same bare id genuinely differs in
 * price and limits between them.
 */
function select(found: Candidates, index: CatalogIndex, provider: ResolvedProvider, form: KeyForm): Outcome {
  const candidates = found.entries
  if (candidates.length === 0) {
    return undefined
  }

  const groups = new Map<string, CatalogEntry[]>()
  for (const candidate of candidates) {
    const key = (candidate.sourceProvider ?? '').toLowerCase()
    const bucket = groups.get(key)
    if (bucket === undefined) {
      groups.set(key, [candidate])
    } else {
      bucket.push(candidate)
    }
  }

  let group = groups.size === 1 ? [...groups.values()][0] : undefined
  if (group === undefined) {
    // A vendor named in the request never reaches this point: `keyForms` already scopes to it.
    const tiers = [provider.catalogProvider, provider.id, index.vendors.get(bareId(form.id).toLowerCase())]
    for (const tier of tiers) {
      const match = tier === undefined ? undefined : groups.get(tier.toLowerCase())
      if (match !== undefined) {
        group = match
        break
      }
    }
  }

  if (group === undefined) {
    return { ambiguous: candidates }
  }

  const winner = group[0]
  if (winner === undefined) {
    return undefined
  }

  return {
    hit: {
      entry: winner,
      // pi.dev is the only source carrying `thinkingLevelMap` and `compat`, so it is the only useful donor.
      donor: group.find(entry => entry !== winner && entry.source === 'pi.dev'),
      // The vendor prefix did work: it either scoped the lookup, or only the stripped id matched.
      viaVendorSplit: form.vendorScoped || (found.viaBare && form.vendor !== undefined),
    },
  }
}

function lookup(index: CatalogIndex, provider: ResolvedProvider, id: string): Outcome {
  for (const form of keyForms(provider, id)) {
    const outcome = select(candidatesFor(index, form), index, provider, form)
    if (outcome !== undefined) {
      return outcome
    }
  }

  return undefined
}

function matched(hit: Hit, matchKind: MatchKind, prefixRule?: AffixRule, suffixRule?: AffixRule): ResolvedMatch {
  return { kind: 'resolved', entry: hit.entry, donor: hit.donor, matchKind, prefixRule, suffixRule }
}

/** Removes at most one prefix and one suffix; a no-op or empty residual is not a match. */
function strip(id: string, prefix: AffixRule | undefined, suffix: AffixRule | undefined): string | undefined {
  let out = id
  if (prefix !== undefined) {
    if (!out.startsWith(prefix.value)) {
      return undefined
    }
    out = out.slice(prefix.value.length)
  }
  if (suffix !== undefined) {
    if (!out.endsWith(suffix.value)) {
      return undefined
    }
    out = out.slice(0, out.length - suffix.value.length)
  }

  return out.length === 0 || out === id ? undefined : out
}

/** unset = every rule · `[]` = none · `['id']` = only those. */
function gateRules(allowed: string[] | undefined, rules: AffixRule[]): AffixRule[] {
  if (allowed === undefined) {
    return rules
  }
  const ids = new Set(allowed)

  return rules.filter(rule => ids.has(rule.id))
}

/**
 * Single strips before double strips, so `x-preview-free` does not lose `-preview` when only `-free`
 * was needed. Rules arrive longest-value-first, so a broad `-free` cannot shadow `-preview-free`.
 */
function combinations(prefixes: AffixRule[], suffixes: AffixRule[]): [AffixRule | undefined, AffixRule | undefined][] {
  const combos: [AffixRule | undefined, AffixRule | undefined][] = []
  for (const suffix of suffixes) {
    combos.push([undefined, suffix])
  }
  for (const prefix of prefixes) {
    combos.push([prefix, undefined])
  }
  for (const prefix of prefixes) {
    for (const suffix of suffixes) {
      combos.push([prefix, suffix])
    }
  }

  return combos
}

export function resolveModel(input: ResolveInput): Resolution {
  const { index, provider, modelId } = input
  const gate = provider.models.get(modelId)

  if (gate?.skip === true) {
    return { kind: 'unresolved', reason: 'skipped' }
  }

  // An alias miss is reported rather than falling through, which would hide a config typo forever.
  if (gate?.alias !== undefined) {
    const outcome = lookup(index, provider, gate.alias)
    if (outcome === undefined) {
      return { kind: 'unresolved', reason: 'alias-miss' }
    }

    return 'ambiguous' in outcome ? { kind: 'ambiguous', candidates: outcome.ambiguous } : matched(outcome.hit, 'alias')
  }

  // The unstripped id always comes first: catalogs really do carry `:free` and `-free` as distinct
  // entries with their own pricing.
  const direct = lookup(index, provider, modelId)
  if (direct !== undefined) {
    if ('ambiguous' in direct) {
      return { kind: 'ambiguous', candidates: direct.ambiguous }
    }

    return matched(direct.hit, direct.hit.viaVendorSplit ? 'vendor-qualified' : 'exact')
  }

  const combos = combinations(
    gateRules(gate?.prefixes, input.prefixRules),
    gateRules(gate?.suffixes, input.suffixRules),
  )
  for (const [prefix, suffix] of combos) {
    const stripped = strip(modelId, prefix, suffix)
    if (stripped === undefined) {
      continue
    }
    const outcome = lookup(index, provider, stripped)
    if (outcome === undefined) {
      continue
    }

    return 'ambiguous' in outcome
      ? { kind: 'ambiguous', candidates: outcome.ambiguous }
      : matched(outcome.hit, 'stripped', prefix, suffix)
  }

  const hadRules = input.prefixRules.length > 0 || input.suffixRules.length > 0

  return { kind: 'unresolved', reason: hadRules && combos.length === 0 ? 'rules-disabled' : 'no-match' }
}
