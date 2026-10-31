import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { toJsonSchema } from '@valibot/to-json-schema'
import * as v from 'valibot'

export const EXTENSION_ID = 'pi-codex-downgrade-detector'
const CONFIG_SCHEMA_URL =
  'https://raw.githubusercontent.com/mzwing/pi-packages/master/packages/pi-codex-downgrade-detector/schemas/config.schema.json'

const nonBlankSchema = v.pipe(v.string(), v.trim(), v.minLength(1))
const providersSchema = v.array(nonBlankSchema)
const tiersSchema = v.record(nonBlankSchema, v.pipe(v.number(), v.safeInteger()))

const fileSchema = v.strictObject({
  $schema: v.optional(v.pipe(v.string(), v.minLength(1))),
  providers: v.optional(providersSchema),
  tiers: v.optional(tiersSchema),
  checkEffort: v.optional(v.boolean()),
  notify: v.optional(v.boolean()),
})

const configSchema = v.strictObject({
  ...fileSchema.entries,
  providers: v.optional(providersSchema, ['openai-codex']),
  tiers: v.optional(tiersSchema, {}),
  checkEffort: v.optional(v.boolean(), true),
  notify: v.optional(v.boolean(), true),
})

// `isolatedDeclarations` cannot emit a `v.InferOutput` of a private schema; `DEFAULT_CONFIG` keeps the two in step.
export interface DetectorConfig {
  $schema?: string | undefined
  providers: string[]
  tiers: Record<string, number>
  checkEffort: boolean
  notify: boolean
}

export const DEFAULT_CONFIG: DetectorConfig = v.parse(configSchema, {})

export interface ConfigPaths {
  global: string
  project: string
}

export interface LoadedConfig {
  config: DetectorConfig
  issues: string[]
}

export function configPaths(cwd: string): ConfigPaths {
  return {
    global: join(getAgentDir(), 'extensions', EXTENSION_ID, 'config.json'),
    project: join(cwd, '.pi', 'extensions', EXTENSION_ID, 'config.json'),
  }
}

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

/** Falls back to the defaults when either scope is unusable, rather than applying half a config. */
export function loadConfig(cwd: string): LoadedConfig {
  const paths = configPaths(cwd)
  const issues: string[] = []
  const global = readScope(paths.global, issues)
  const project = readScope(paths.project, issues)
  if (global === undefined || project === undefined) {
    return { config: DEFAULT_CONFIG, issues }
  }

  // A project that ranks one new slug keeps the ranks the global file established.
  const config = v.parse(configSchema, { ...global, ...project, tiers: { ...global.tiers, ...project.tiers } })

  return { config, issues }
}

export function buildJsonSchema(): Record<string, unknown> {
  const { $schema, ...schema } = toJsonSchema(configSchema, {
    target: 'draft-2020-12',
    typeMode: 'input',
    ignoreActions: ['trim'],
  })

  return { $schema, $id: CONFIG_SCHEMA_URL, ...schema }
}
