import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { z } from 'zod'

export const EXTENSION_ID = 'pi-task-governor'
const CONFIG_SCHEMA_URL =
  'https://raw.githubusercontent.com/mzwing/pi-packages/master/packages/pi-task-governor/schemas/config.schema.json'

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const ENV_PROVIDERS = ['auto', 'direnv', 'flake', 'none'] as const

const coordinatorSchema = z.strictObject({
  instructions: z.string().trim().min(1).optional(),
})

const roleSchema = coordinatorSchema.extend({
  model: z.string().trim().min(1).optional(),
  thinking: z.enum(THINKING_LEVELS).optional(),
})

// Only developers and reviewers have a turn budget; an executor runs until its task ends.
const subagentSchema = roleSchema.extend({ maxTurns: z.number().int().min(2).optional() })

const envSchema = z.strictObject({
  provider: z.enum(ENV_PROVIDERS).optional(),
  setup: z.array(z.string().trim().min(1)).optional(),
})

const checkSchema = z.strictObject({
  statement: z.string().trim().min(1),
  check: z.string().trim().min(1),
})

const fileSchema = z.strictObject({
  $schema: z.string().min(1).optional(),
  workspaceRoot: z.string().trim().min(1).optional(),
  maxExecutors: z.number().int().positive().optional(),
  defaultBookmark: z.string().trim().min(1).optional(),
  roles: z
    .strictObject({
      coordinator: coordinatorSchema.optional(),
      executor: roleSchema.optional(),
      developer: subagentSchema.optional(),
      reviewer: subagentSchema.optional(),
    })
    .optional(),
  env: envSchema.optional(),
  globalChecks: z.array(checkSchema).optional(),
})

const configSchema = fileSchema.extend({
  maxExecutors: z.number().int().positive().default(3),
  defaultBookmark: z.string().trim().min(1).default('main'),
  roles: z
    .strictObject({
      coordinator: coordinatorSchema.prefault({}),
      executor: roleSchema.prefault({}),
      developer: roleSchema.extend({ maxTurns: z.number().int().min(2).default(100) }).prefault({}),
      reviewer: roleSchema.extend({ maxTurns: z.number().int().min(2).default(40) }).prefault({}),
    })
    .prefault({}),
  env: envSchema
    .extend({ provider: z.enum(ENV_PROVIDERS).default('auto'), setup: z.array(z.string().trim().min(1)).default([]) })
    .prefault({}),
  globalChecks: z.array(checkSchema).default([]),
})

type ConfigFile = z.infer<typeof fileSchema>

export type ThinkingLevel = (typeof THINKING_LEVELS)[number]
export type EnvProvider = (typeof ENV_PROVIDERS)[number]

interface CoordinatorConfig {
  /** Added to the role's built-in instructions in its system prompt. */
  instructions?: string | undefined
}

interface RoleConfig extends CoordinatorConfig {
  model?: string | undefined
  thinking?: ThinkingLevel | undefined
}

// `isolatedDeclarations` cannot emit a `z.infer` of a private schema; `DEFAULT_CONFIG` keeps the two in step.
export interface GovernorConfig {
  $schema?: string | undefined
  /** Where task workspaces go; defaults to `<repo>.tasks` beside the repository. */
  workspaceRoot?: string | undefined
  maxExecutors: number
  defaultBookmark: string
  roles: {
    coordinator: CoordinatorConfig
    executor: RoleConfig
    developer: RoleConfig & { maxTurns: number }
    reviewer: RoleConfig & { maxTurns: number }
  }
  env: { provider: EnvProvider; setup: string[] }
  globalChecks: { statement: string; check: string }[]
}

export const DEFAULT_CONFIG: GovernorConfig = configSchema.parse({})

export interface LoadedConfig {
  config: GovernorConfig
  issues: string[]
}

// Not imported from tooling.ts: scripts/generate-schema.ts runs this file under Node, which cannot resolve `.js` imports of sources.
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readScope(path: string, issues: string[]): ConfigFile | undefined {
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

export function configPaths(repoRoot: string): { global: string; project: string } {
  return {
    global: join(getAgentDir(), 'extensions', EXTENSION_ID, 'config.json'),
    project: join(repoRoot, '.pi', 'extensions', EXTENSION_ID, 'config.json'),
  }
}

/**
 * Project fields override global ones, role by role. An untrusted project's file is left unread, and an unusable
 * scope leaves the defaults in force rather than half a config.
 */
export function loadConfig(repoRoot: string, projectTrusted: boolean): LoadedConfig {
  const paths = configPaths(repoRoot)
  const issues: string[] = []
  const global = readScope(paths.global, issues)
  const project = projectTrusted ? readScope(paths.project, issues) : {}
  if (global === undefined || project === undefined) {
    return { config: DEFAULT_CONFIG, issues }
  }
  const config = configSchema.parse({
    ...global,
    ...project,
    roles: {
      coordinator: { ...global.roles?.coordinator, ...project.roles?.coordinator },
      executor: { ...global.roles?.executor, ...project.roles?.executor },
      developer: { ...global.roles?.developer, ...project.roles?.developer },
      reviewer: { ...global.roles?.reviewer, ...project.roles?.reviewer },
    },
    env: { ...global.env, ...project.env },
  })

  return { config, issues }
}

export function buildJsonSchema(): Record<string, unknown> {
  const { $schema, ...schema } = z.toJSONSchema(configSchema, { target: 'draft-2020-12', io: 'input' })

  return { $schema, $id: CONFIG_SCHEMA_URL, ...schema }
}
