import type { AffixRule, ModelCompat, ModelGate, ResolvedConfig, ResolvedProvider } from './types.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { toJsonSchema } from '@valibot/to-json-schema'
import * as v from 'valibot'

export const EXTENSION_ID = 'pi-model-info'
const CONFIG_SCHEMA_URL =
  'https://raw.githubusercontent.com/mzwing/pi-packages/master/packages/pi-model-info/schemas/config.schema.json'

const FREE_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** Suffix variants every relay uses; each can be disabled with `enabled: false` */
const BUILTIN_RULES: AffixRule[] = [
  { id: 'free-dash', kind: 'suffix', value: '-free', override: { cost: FREE_COST } },
  { id: 'free-colon', kind: 'suffix', value: ':free', override: { cost: FREE_COST } },
]

const nonBlankSchema = v.pipe(v.string(), v.trim(), v.minLength(1))
const nonNegativeSchema = v.pipe(v.number(), v.minValue(0))
const positiveIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1))

// Spelled out rather than derived from THINKING_LEVELS, so the inferred type is the exact map shape
const thinkingValue = v.optional(v.nullable(v.string()))
const thinkingLevelMapSchema = v.strictObject({
  off: thinkingValue,
  minimal: thinkingValue,
  low: thinkingValue,
  medium: thinkingValue,
  high: thinkingValue,
  xhigh: thinkingValue,
  max: thinkingValue,
})

const costTierSchema = v.strictObject({
  input: nonNegativeSchema,
  output: nonNegativeSchema,
  cacheRead: nonNegativeSchema,
  cacheWrite: nonNegativeSchema,
  inputTokensAbove: positiveIntegerSchema,
})

const metadataOverrideSchema = v.strictObject({
  name: v.optional(nonBlankSchema),
  reasoning: v.optional(v.boolean()),
  input: v.optional(v.pipe(v.array(v.picklist(['text', 'image'])), v.minLength(1))),
  cost: v.optional(
    v.strictObject({
      input: v.optional(nonNegativeSchema),
      output: v.optional(nonNegativeSchema),
      cacheRead: v.optional(nonNegativeSchema),
      cacheWrite: v.optional(nonNegativeSchema),
      tiers: v.optional(v.array(costTierSchema)),
    }),
  ),
  contextWindow: v.optional(positiveIntegerSchema),
  maxTokens: v.optional(positiveIntegerSchema),
  thinkingLevelMap: v.optional(thinkingLevelMapSchema),
  // Pi validates its api-keyed `compat` union on registration; duplicating it here would only go stale
  compat: v.optional(
    v.custom<ModelCompat>(
      value => typeof value === 'object' && value !== null && !Array.isArray(value),
      'compat must be an object',
    ),
  ),
})

const affixRuleSchema = v.strictObject({
  id: nonBlankSchema,
  kind: v.picklist(['prefix', 'suffix']),
  value: v.pipe(v.string(), v.minLength(1)),
  enabled: v.optional(v.boolean()),
  override: v.optional(metadataOverrideSchema),
})

const modelGateSchema = v.strictObject({
  prefixes: v.optional(v.array(nonBlankSchema)),
  suffixes: v.optional(v.array(nonBlankSchema)),
  alias: v.optional(nonBlankSchema),
  override: v.optional(metadataOverrideSchema),
  skip: v.optional(v.boolean()),
})

const providerOptInSchema = v.strictObject({
  catalogProvider: v.optional(nonBlankSchema),
  costMultiplier: v.optional(nonNegativeSchema),
  costPolicy: v.optional(v.picklist(['catalog', 'zero', 'keep'])),
  contextWindowPolicy: v.optional(v.picklist(['catalog', 'min', 'keep'])),
  capabilityPolicy: v.optional(v.picklist(['catalog', 'widen', 'keep'])),
  useCatalogName: v.optional(v.boolean()),
  mapThinkingLevels: v.optional(v.boolean()),
  allowDynamic: v.optional(v.boolean()),
  models: v.optional(v.record(nonBlankSchema, modelGateSchema)),
})

const fileSchema = v.strictObject({
  $schema: v.optional(v.pipe(v.string(), v.minLength(1))),
  providers: v.optional(v.record(nonBlankSchema, providerOptInSchema)),
  aliases: v.optional(v.record(nonBlankSchema, nonBlankSchema)),
  models: v.optional(v.record(nonBlankSchema, modelGateSchema)),
  rules: v.optional(
    v.pipe(
      v.array(affixRuleSchema),
      v.checkItems(
        (rule, index, rules) => rules.findIndex(other => other.id === rule.id) === index,
        issue => `duplicate rule id '${issue.input.id}'`,
      ),
    ),
  ),
  builtinRules: v.optional(v.boolean()),
  sources: v.optional(
    v.pipe(
      v.array(v.picklist(['pi.dev', 'models.dev'])),
      v.minLength(1),
      v.checkItems((source, index, sources) => sources.indexOf(source) === index, 'sources must not repeat a value'),
    ),
  ),
  network: v.optional(
    v.strictObject({
      enabled: v.optional(v.boolean()),
      timeoutMs: v.optional(v.pipe(positiveIntegerSchema, v.maxValue(120_000))),
      maxBytes: v.optional(positiveIntegerSchema),
    }),
  ),
  cache: v.optional(
    v.strictObject({
      ttlMs: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
      dir: v.optional(nonBlankSchema),
    }),
  ),
  applyOnIdleOnly: v.optional(v.boolean()),
})

export interface LoadedConfig {
  /** `undefined` when either scope is unusable, which leaves the extension inert */
  config: ResolvedConfig | undefined
  issues: string[]
}

// Not imported from util.ts: scripts/generate-schema.ts runs this file under Node, which cannot resolve `.js` imports of sources
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readScope(path: string, issues: string[]): v.InferOutput<typeof fileSchema> | undefined {
  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {}
    }
    issues.push(`${path}: ${describeError(error)}`)

    return undefined
  }

  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    issues.push(`${path}: invalid JSON: ${describeError(error)}`)

    return undefined
  }
  const parsed = v.safeParse(fileSchema, value)
  if (!parsed.success) {
    const details = parsed.issues.map(issue => `${v.getDotPath(issue) ?? '(root)'}: ${issue.message}`)
    issues.push(`${path}: ${details.join('; ')}`)

    return undefined
  }

  return parsed.output
}

function orderRules(rules: AffixRule[]): AffixRule[] {
  return rules
    .map((rule, ordinal) => ({ rule, ordinal }))
    .sort((left, right) => right.rule.value.length - left.rule.value.length || left.ordinal - right.ordinal)
    .map(entry => entry.rule)
}

/** Folds the flat sugar into per-provider gates; an unusable entry is reported and dropped, the rest still applies */
function resolve(config: v.InferOutput<typeof fileSchema>, issue: (message: string) => void): ResolvedConfig {
  const providers = new Map<string, ResolvedProvider>()
  for (const [id, optIn] of Object.entries(config.providers ?? {})) {
    providers.set(id, {
      id,
      catalogProvider: optIn.catalogProvider,
      costMultiplier: optIn.costMultiplier ?? 1,
      costPolicy: optIn.costPolicy ?? 'catalog',
      contextWindowPolicy: optIn.contextWindowPolicy ?? 'catalog',
      capabilityPolicy: optIn.capabilityPolicy ?? 'catalog',
      useCatalogName: optIn.useCatalogName ?? false,
      mapThinkingLevels: optIn.mapThinkingLevels ?? false,
      allowDynamic: optIn.allowDynamic ?? false,
      models: new Map(Object.entries(optIn.models ?? {})),
    })
  }

  const flatGates: [string, string, ModelGate][] = [
    ...Object.entries(config.models ?? {}).map(([key, gate]): [string, string, ModelGate] => ['models', key, gate]),
    ...Object.entries(config.aliases ?? {}).map(([key, alias]): [string, string, ModelGate] => [
      'aliases',
      key,
      { alias },
    ]),
  ]
  for (const [section, key, gate] of flatGates) {
    // Model ids routinely contain `/`, so a key is only unambiguous split at the first one into a known provider
    const separator = key.indexOf('/')
    const provider = separator > 0 && separator < key.length - 1 ? providers.get(key.slice(0, separator)) : undefined
    if (provider === undefined) {
      issue(`${section}['${key}'] does not start with an opted-in provider id`)
      continue
    }
    const modelId = key.slice(separator + 1)
    provider.models.set(modelId, { ...provider.models.get(modelId), ...gate })
  }

  const declared = [...(config.rules ?? []), ...(config.builtinRules === false ? [] : BUILTIN_RULES)]
  const ruleIds = new Set(declared.map(rule => rule.id))
  for (const provider of providers.values()) {
    for (const [modelId, gate] of provider.models) {
      const known = (id: string): boolean => {
        if (!ruleIds.has(id)) {
          issue(`providers['${provider.id}'].models['${modelId}'] references unknown rule '${id}'`)
        }

        return ruleIds.has(id)
      }
      const prefixes = gate.prefixes?.filter(known)
      const suffixes = gate.suffixes?.filter(known)
      provider.models.set(modelId, {
        ...gate,
        ...(prefixes === undefined ? {} : { prefixes }),
        ...(suffixes === undefined ? {} : { suffixes }),
      })
    }
  }

  const enabled = declared.filter(rule => rule.enabled !== false)

  return {
    providers,
    prefixRules: orderRules(enabled.filter(rule => rule.kind === 'prefix')),
    suffixRules: orderRules(enabled.filter(rule => rule.kind === 'suffix')),
    sources: config.sources ?? ['pi.dev', 'models.dev'],
    network: {
      enabled: config.network?.enabled ?? true,
      timeoutMs: config.network?.timeoutMs ?? 15_000,
      maxBytes: config.network?.maxBytes ?? 16 * 1024 * 1024,
    },
    cache: { ttlMs: config.cache?.ttlMs ?? 24 * 60 * 60 * 1000, dir: config.cache?.dir },
    applyOnIdleOnly: config.applyOnIdleOnly ?? true,
  }
}

export function loadConfig(cwd: string): LoadedConfig {
  const globalPath = join(getAgentDir(), 'extensions', EXTENSION_ID, 'config.json')
  const projectPath = join(cwd, '.pi', 'extensions', EXTENSION_ID, 'config.json')
  const issues: string[] = []
  const global = readScope(globalPath, issues)
  const project = readScope(projectPath, issues)
  if (global === undefined || project === undefined) {
    return { config: undefined, issues }
  }

  return { config: resolve({ ...global, ...project }, message => issues.push(`${globalPath}: ${message}`)), issues }
}

export function buildJsonSchema(): Record<string, unknown> {
  const { $schema, ...schema } = toJsonSchema(fileSchema, {
    target: 'draft-2020-12',
    typeMode: 'input',
    ignoreActions: ['trim', 'check_items'],
    // `compat` is the one custom node; left unconstrained rather than copying Pi's version-specific union
    overrideSchema: ({ valibotSchema }) => (valibotSchema.type === 'custom' ? {} : undefined),
  })

  return { $schema, $id: CONFIG_SCHEMA_URL, ...schema }
}
