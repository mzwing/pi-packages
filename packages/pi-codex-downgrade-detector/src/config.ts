import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { z } from 'zod'

export const EXTENSION_ID = 'pi-codex-downgrade-detector'
const CONFIG_SCHEMA_URL =
  'https://raw.githubusercontent.com/mzwing/pi-packages/master/packages/pi-codex-downgrade-detector/schemas/config.schema.json'

const providersSchema = z.array(z.string().trim().min(1))
const tiersSchema = z.record(z.string().trim().min(1), z.number().int())

const fileSchema = z.strictObject({
  $schema: z.string().min(1).optional(),
  providers: providersSchema.optional(),
  tiers: tiersSchema.optional(),
  checkEffort: z.boolean().optional(),
  notify: z.boolean().optional(),
})

const configSchema = fileSchema.extend({
  providers: providersSchema.default(['openai-codex']),
  tiers: tiersSchema.default({}),
  checkEffort: z.boolean().default(true),
  notify: z.boolean().default(true),
})

// `isolatedDeclarations` cannot emit a `z.infer` of a private schema; `DEFAULT_CONFIG` keeps the two in step.
export interface DetectorConfig {
  $schema?: string | undefined
  providers: string[]
  tiers: Record<string, number>
  checkEffort: boolean
  notify: boolean
}

export const DEFAULT_CONFIG: DetectorConfig = configSchema.parse({})

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
    const details = parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    issues.push(`${path}: ${details.join('; ')}`)

    return undefined
  }

  return parsed.data
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
  const config = configSchema.parse({ ...global, ...project, tiers: { ...global.tiers, ...project.tiers } })

  return { config, issues }
}

export function buildJsonSchema(): Record<string, unknown> {
  const { $schema, ...schema } = z.toJSONSchema(configSchema, { target: 'draft-2020-12', io: 'input' })

  return { $schema, $id: CONFIG_SCHEMA_URL, ...schema }
}
