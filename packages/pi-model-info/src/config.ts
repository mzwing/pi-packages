import type {
  AffixRule,
  ModelCompat,
  ModelGate,
  ModelInfoConfig,
  ProviderOptIn,
  ResolvedConfig,
  ResolvedProvider,
  SourceId,
} from './types.js'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { z } from 'zod'

export const EXTENSION_ID = 'pi-model-info'
export const COMMAND_NAME = 'model-info'
const CONFIG_SCHEMA_URL =
  'https://raw.githubusercontent.com/mzwing/pi-packages/main/packages/pi-model-info/schemas/config.schema.json'

export const DEFAULT_SOURCES: SourceId[] = ['pi.dev', 'models.dev']
const DEFAULT_CACHE_TTL_MS: number = 24 * 60 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES: number = 16 * 1024 * 1024

const FREE_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** Suffix variants every relay uses. Disable individually with `enabled: false`. */
const BUILTIN_RULES: AffixRule[] = [
  { id: 'free-dash', kind: 'suffix', value: '-free', override: { cost: FREE_COST } },
  { id: 'free-colon', kind: 'suffix', value: ':free', override: { cost: FREE_COST } },
]

// ── Schema (module-private: `isolatedDeclarations` makes exporting it unworkable) ──

// Spelled out rather than derived from THINKING_LEVELS so the inferred type is the exact
// `ThinkingLevelMap` shape instead of a string index signature.
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
  // Pi's `compat` is a three-way union keyed on `api`; reproducing it here would duplicate hundreds
  // of lines Pi already validates on registration, so the check stays structural.
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

const configFileShape = {
  $schema: z.string().min(1).optional(),
  providers: z.record(z.string().trim().min(1), providerOptInSchema).optional(),
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
}

const configFileSchema = z.strictObject(configFileShape)

const modelInfoConfigSchema = z
  .strictObject({
    ...configFileShape,
    providers: z.record(z.string().trim().min(1), providerOptInSchema).default({}),
  })
  .superRefine((config, context) => {
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

/**
 * One scope on disk, where `providers` only becomes required once the two scopes are merged.
 * Hand-written because `isolatedDeclarations` cannot emit a `z.infer` of a module-private schema;
 * `test/config.test.ts` asserts the two stay in step.
 */
interface ModelInfoConfigFile extends Omit<ModelInfoConfig, 'providers'> {
  providers?: Record<string, ProviderOptIn> | undefined
}

// ── Paths and loading ─────────────────────────────────────────────────────────

export interface ConfigIssue {
  sourcePath: string
  message: string
}

export interface ModelInfoConfigPaths {
  globalPath: string
  projectPath: string
}

export interface LoadConfigResult {
  config: ModelInfoConfig | undefined
  issues: ConfigIssue[]
  globalPath: string
  projectPath: string
}

export interface LoadConfigOptions {
  cwd: string
  agentDir?: string
  readFile?: (path: string) => string | undefined
}

export function defaultModelInfoAgentDir(): string {
  return process.env['PI_CODING_AGENT_DIR'] ?? join(homedir(), '.pi', 'agent')
}

export function getModelInfoConfigPaths(
  cwd: string,
  agentDir: string = defaultModelInfoAgentDir(),
): ModelInfoConfigPaths {
  return {
    globalPath: join(agentDir, 'extensions', EXTENSION_ID, 'config.json'),
    projectPath: join(cwd, '.pi', 'extensions', EXTENSION_ID, 'config.json'),
  }
}

/** Reads a config file, reporting a missing one as `undefined` rather than an error. */
function readConfigFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

function formatZodIssue(error: z.ZodError): string {
  return error.issues
    .map(issue => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ')
}

/** Returns `undefined` on failure, having recorded why; an absent file reads as an empty scope. */
function readScope(
  path: string,
  readFile: (path: string) => string | undefined,
  issues: ConfigIssue[],
): ModelInfoConfigFile | undefined {
  let source: string | undefined
  try {
    source = readFile(path)
  } catch (error) {
    issues.push({ sourcePath: path, message: error instanceof Error ? error.message : String(error) })

    return undefined
  }
  if (source === undefined) {
    return {}
  }

  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    issues.push({
      sourcePath: path,
      message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    })

    return undefined
  }

  const parsed = configFileSchema.safeParse(value)
  if (!parsed.success) {
    issues.push({ sourcePath: path, message: formatZodIssue(parsed.error) })

    return undefined
  }

  return parsed.data
}

export function loadModelInfoConfig(options: LoadConfigOptions): LoadConfigResult {
  const { globalPath, projectPath } = getModelInfoConfigPaths(options.cwd, options.agentDir)
  const readFile = options.readFile ?? readConfigFile
  const issues: ConfigIssue[] = []
  const globalConfig = readScope(globalPath, readFile, issues)
  const projectConfig = readScope(projectPath, readFile, issues)

  if (globalConfig === undefined || projectConfig === undefined) {
    return { config: undefined, issues, globalPath, projectPath }
  }

  const merged = modelInfoConfigSchema.safeParse({ ...globalConfig, ...projectConfig })
  if (!merged.success) {
    issues.push({ sourcePath: projectPath, message: formatZodIssue(merged.error) })

    return { config: undefined, issues, globalPath, projectPath }
  }

  return { config: merged.data, issues, globalPath, projectPath }
}

// ── Desugaring ────────────────────────────────────────────────────────────────

export interface ResolveConfigResult {
  config: ResolvedConfig
  issues: ConfigIssue[]
}

/**
 * Model ids routinely contain `/`, so a flat `"provider/model"` key is only unambiguous because
 * provider ids are known: split at the FIRST separator and require the head to be an opted-in one.
 */
function splitFlatKey(key: string, providers: Map<string, ResolvedProvider>): [ResolvedProvider, string] | undefined {
  const separator = key.indexOf('/')
  if (separator <= 0 || separator === key.length - 1) {
    return undefined
  }
  const provider = providers.get(key.slice(0, separator))

  return provider === undefined ? undefined : [provider, key.slice(separator + 1)]
}

function orderRules(rules: AffixRule[]): AffixRule[] {
  return rules
    .map((rule, ordinal) => ({ rule, ordinal }))
    .sort((a, b) => b.rule.value.length - a.rule.value.length || a.ordinal - b.ordinal)
    .map(entry => entry.rule)
}

/** The flat `models` and `aliases` sugar, as `[section, key, gate]` in the order they are folded in. */
function flatGates(config: ModelInfoConfig): [string, string, ModelGate][] {
  return [
    ...Object.entries(config.models ?? {}).map(([key, gate]): [string, string, ModelGate] => ['models', key, gate]),
    ...Object.entries(config.aliases ?? {}).map(([key, alias]): [string, string, ModelGate] => [
      'aliases',
      key,
      { alias },
    ]),
  ]
}

/**
 * Materialises defaults, folds the flat sugar into per-provider gates, and orders the affix rules.
 * Problems here are reported, not fatal: an unusable entry is dropped and the rest still applies.
 */
export function resolveModelInfoConfig(config: ModelInfoConfig, sourcePath: string): ResolveConfigResult {
  const issues: ConfigIssue[] = []
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

  for (const [section, key, gate] of flatGates(config)) {
    const split = splitFlatKey(key, providers)
    if (split === undefined) {
      issues.push({ sourcePath, message: `${section}['${key}'] does not start with an opted-in provider id` })
      continue
    }
    const [provider, modelId] = split
    provider.models.set(modelId, { ...provider.models.get(modelId), ...gate })
  }

  const declared = [...(config.rules ?? []), ...(config.builtinRules === false ? [] : BUILTIN_RULES)]
  const enabled = declared.filter(rule => rule.enabled !== false)
  const ruleIds = new Set(declared.map(rule => rule.id))

  for (const provider of providers.values()) {
    for (const [modelId, gate] of provider.models) {
      const known = (id: string): boolean => {
        if (ruleIds.has(id)) {
          return true
        }
        issues.push({
          sourcePath,
          message: `providers['${provider.id}'].models['${modelId}'] references unknown rule '${id}'`,
        })

        return false
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

  return {
    config: {
      providers,
      prefixRules: orderRules(enabled.filter(rule => rule.kind === 'prefix')),
      suffixRules: orderRules(enabled.filter(rule => rule.kind === 'suffix')),
      sources: config.sources ?? DEFAULT_SOURCES,
      network: {
        enabled: config.network?.enabled ?? true,
        timeoutMs: config.network?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBytes: config.network?.maxBytes ?? DEFAULT_MAX_BYTES,
      },
      cache: { ttlMs: config.cache?.ttlMs ?? DEFAULT_CACHE_TTL_MS, dir: config.cache?.dir },
      applyOnIdleOnly: config.applyOnIdleOnly ?? true,
    },
    issues,
  }
}

export function buildModelInfoJsonSchema(): Record<string, unknown> {
  const { $schema, ...schema } = z.toJSONSchema(modelInfoConfigSchema, {
    target: 'draft-2020-12',
    io: 'input',
    // `compat` is the one custom node here. Pi owns its large, version-specific union and validates
    // it on registration, so the published schema leaves it unconstrained rather than going stale.
    unrepresentable: 'any',
  })

  return { $schema, $id: CONFIG_SCHEMA_URL, ...schema }
}
