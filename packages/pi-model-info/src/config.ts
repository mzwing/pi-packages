import type { AffixRule, ModelCompat, ModelGate, ResolvedConfig, ResolvedProvider } from './types.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { z } from 'zod'

export const EXTENSION_ID = 'pi-model-info'
const CONFIG_SCHEMA_URL =
  'https://raw.githubusercontent.com/mzwing/pi-packages/main/packages/pi-model-info/schemas/config.schema.json'

const FREE_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** Suffix variants every relay uses; each can be disabled with `enabled: false`. */
const BUILTIN_RULES: AffixRule[] = [
  { id: 'free-dash', kind: 'suffix', value: '-free', override: { cost: FREE_COST } },
  { id: 'free-colon', kind: 'suffix', value: ':free', override: { cost: FREE_COST } },
]

// Spelled out rather than derived from THINKING_LEVELS, so the inferred type is the exact map shape.
const thinkingValue = z.union([z.string(), z.null()]).optional()
const thinkingLevelMapSchema = z.strictObject({
  off: thinkingValue,
  minimal: thinkingValue,
  low: thinkingValue,
  medium: thinkingValue,
  high: thinkingValue,
  xhigh: thinkingValue,
  max: thinkingValue,
})

const costTierSchema = z.strictObject({
  input: z.number().min(0),
  output: z.number().min(0),
  cacheRead: z.number().min(0),
  cacheWrite: z.number().min(0),
  inputTokensAbove: z.number().int().positive(),
})

const metadataOverrideSchema = z.strictObject({
  name: z.string().trim().min(1).optional(),
  reasoning: z.boolean().optional(),
  input: z
    .array(z.enum(['text', 'image']))
    .min(1)
    .optional(),
  cost: z
    .strictObject({
      input: z.number().min(0).optional(),
      output: z.number().min(0).optional(),
      cacheRead: z.number().min(0).optional(),
      cacheWrite: z.number().min(0).optional(),
      tiers: z.array(costTierSchema).optional(),
    })
    .optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  thinkingLevelMap: thinkingLevelMapSchema.optional(),
  // Pi validates its api-keyed `compat` union on registration; duplicating it here would only go stale.
  compat: z
    .custom<ModelCompat>(value => typeof value === 'object' && value !== null && !Array.isArray(value), {
      message: 'compat must be an object',
    })
    .optional(),
})

const affixRuleSchema = z.strictObject({
  id: z.string().trim().min(1),
  kind: z.enum(['prefix', 'suffix']),
  value: z.string().min(1),
  enabled: z.boolean().optional(),
  override: metadataOverrideSchema.optional(),
})

const modelGateSchema = z.strictObject({
  prefixes: z.array(z.string().trim().min(1)).optional(),
  suffixes: z.array(z.string().trim().min(1)).optional(),
  alias: z.string().trim().min(1).optional(),
  override: metadataOverrideSchema.optional(),
  skip: z.boolean().optional(),
})

const providerOptInSchema = z.strictObject({
  catalogProvider: z.string().trim().min(1).optional(),
  costMultiplier: z.number().min(0).optional(),
  costPolicy: z.enum(['catalog', 'zero', 'keep']).optional(),
  contextWindowPolicy: z.enum(['catalog', 'min', 'keep']).optional(),
  capabilityPolicy: z.enum(['catalog', 'widen', 'keep']).optional(),
  useCatalogName: z.boolean().optional(),
  mapThinkingLevels: z.boolean().optional(),
  allowDynamic: z.boolean().optional(),
  models: z.record(z.string().trim().min(1), modelGateSchema).optional(),
})

const providersSchema = z.record(z.string().trim().min(1), providerOptInSchema)

const fileSchema = z.strictObject({
  $schema: z.string().min(1).optional(),
  providers: providersSchema.optional(),
  aliases: z.record(z.string().trim().min(1), z.string().trim().min(1)).optional(),
  models: z.record(z.string().trim().min(1), modelGateSchema).optional(),
  rules: z.array(affixRuleSchema).optional(),
  builtinRules: z.boolean().optional(),
  sources: z
    .array(z.enum(['pi.dev', 'models.dev']))
    .min(1)
    .optional(),
  network: z
    .strictObject({
      enabled: z.boolean().optional(),
      timeoutMs: z.number().int().positive().max(120_000).optional(),
      maxBytes: z.number().int().positive().optional(),
    })
    .optional(),
  cache: z
    .strictObject({
      ttlMs: z.number().int().min(0).optional(),
      dir: z.string().trim().min(1).optional(),
    })
    .optional(),
  applyOnIdleOnly: z.boolean().optional(),
})

const configSchema = fileSchema.extend({ providers: providersSchema.default({}) }).superRefine((config, context) => {
  const seen = new Set<string>()
  for (const [index, rule] of (config.rules ?? []).entries()) {
    if (seen.has(rule.id)) {
      context.addIssue({ code: 'custom', message: `duplicate rule id '${rule.id}'`, path: ['rules', index, 'id'] })
    }
    seen.add(rule.id)
  }
  if (config.sources && new Set(config.sources).size !== config.sources.length) {
    context.addIssue({ code: 'custom', message: 'sources must not repeat a value', path: ['sources'] })
  }
})

export interface LoadedConfig {
  /** `undefined` when either scope is unusable, which leaves the extension inert. */
  config: ResolvedConfig | undefined
  issues: string[]
}

// Not imported from util.ts: scripts/generate-schema.ts runs this file under Node, which cannot resolve `.js` imports of sources.
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')
}

function readScope(path: string, issues: string[]): z.infer<typeof fileSchema> | undefined {
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
  const parsed = fileSchema.safeParse(value)
  if (!parsed.success) {
    issues.push(`${path}: ${formatIssues(parsed.error)}`)

    return undefined
  }

  return parsed.data
}

function orderRules(rules: AffixRule[]): AffixRule[] {
  return rules
    .map((rule, ordinal) => ({ rule, ordinal }))
    .sort((left, right) => right.rule.value.length - left.rule.value.length || left.ordinal - right.ordinal)
    .map(entry => entry.rule)
}

/** Folds the flat sugar into per-provider gates; an unusable entry is reported and dropped, the rest still applies. */
function resolve(config: z.infer<typeof configSchema>, issue: (message: string) => void): ResolvedConfig {
  const providers = new Map<string, ResolvedProvider>()
  for (const [id, optIn] of Object.entries(config.providers)) {
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
    // Model ids routinely contain `/`, so a key is only unambiguous split at the first one into a known provider.
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

  const merged = configSchema.safeParse({ ...global, ...project })
  if (!merged.success) {
    return { config: undefined, issues: [`${projectPath}: ${formatIssues(merged.error)}`] }
  }

  return { config: resolve(merged.data, message => issues.push(`${globalPath}: ${message}`)), issues }
}

export function buildJsonSchema(): Record<string, unknown> {
  const { $schema, ...schema } = z.toJSONSchema(configSchema, {
    target: 'draft-2020-12',
    io: 'input',
    // `compat` is the one custom node; left unconstrained rather than copying Pi's version-specific union.
    unrepresentable: 'any',
  })

  return { $schema, $id: CONFIG_SCHEMA_URL, ...schema }
}
