import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { toJsonSchema } from '@valibot/to-json-schema'
import * as v from 'valibot'

export const EXTENSION_ID = 'pi-task-governor'
const CONFIG_SCHEMA_URL =
  'https://raw.githubusercontent.com/mzwing/pi-packages/master/packages/pi-task-governor/schemas/config.schema.json'

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const ENV_PROVIDERS = ['auto', 'direnv', 'flake', 'none'] as const

const nonBlankSchema = v.pipe(v.string(), v.trim(), v.minLength(1))
const maxExecutorsSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1))
// At its limit a coordinator is reminded to hand off, an executor hands off, and a developer or reviewer must finish
const turnsSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(2))

const coordinatorSchema = v.strictObject({
  instructions: v.optional(nonBlankSchema),
  maxTurns: v.optional(turnsSchema),
})

const roleSchema = v.strictObject({
  ...coordinatorSchema.entries,
  model: v.optional(nonBlankSchema),
  thinking: v.optional(v.picklist(THINKING_LEVELS)),
})

const envSchema = v.strictObject({
  provider: v.optional(v.picklist(ENV_PROVIDERS)),
  setup: v.optional(v.array(nonBlankSchema)),
})

const checkSchema = v.strictObject({
  statement: nonBlankSchema,
  check: nonBlankSchema,
})

const fileSchema = v.strictObject({
  $schema: v.optional(v.pipe(v.string(), v.minLength(1))),
  workspaceRoot: v.optional(nonBlankSchema),
  maxExecutors: v.optional(maxExecutorsSchema),
  defaultBookmark: v.optional(nonBlankSchema),
  roles: v.optional(
    v.strictObject({
      coordinator: v.optional(coordinatorSchema),
      executor: v.optional(roleSchema),
      developer: v.optional(roleSchema),
      reviewer: v.optional(roleSchema),
    }),
  ),
  env: v.optional(envSchema),
  globalChecks: v.optional(v.array(checkSchema)),
})

const configSchema = v.strictObject({
  ...fileSchema.entries,
  maxExecutors: v.optional(maxExecutorsSchema, 3),
  defaultBookmark: v.optional(nonBlankSchema, 'main'),
  roles: v.optional(
    v.strictObject({
      coordinator: v.optional(
        v.strictObject({ ...coordinatorSchema.entries, maxTurns: v.optional(turnsSchema, 100) }),
        {},
      ),
      executor: v.optional(v.strictObject({ ...roleSchema.entries, maxTurns: v.optional(turnsSchema, 100) }), {}),
      developer: v.optional(v.strictObject({ ...roleSchema.entries, maxTurns: v.optional(turnsSchema, 100) }), {}),
      reviewer: v.optional(v.strictObject({ ...roleSchema.entries, maxTurns: v.optional(turnsSchema, 40) }), {}),
    }),
    {},
  ),
  env: v.optional(
    v.strictObject({
      provider: v.optional(v.picklist(ENV_PROVIDERS), 'auto'),
      setup: v.optional(v.array(nonBlankSchema), []),
    }),
    {},
  ),
  globalChecks: v.optional(v.array(checkSchema), []),
})

type ConfigFile = v.InferOutput<typeof fileSchema>

export type ThinkingLevel = (typeof THINKING_LEVELS)[number]
export type EnvProvider = (typeof ENV_PROVIDERS)[number]

interface CoordinatorConfig {
  /** Added to the role's built-in instructions in its system prompt */
  instructions?: string | undefined
  maxTurns: number
}

interface RoleConfig extends CoordinatorConfig {
  model?: string | undefined
  thinking?: ThinkingLevel | undefined
}

// `isolatedDeclarations` cannot emit a `v.InferOutput` of a private schema; `DEFAULT_CONFIG` keeps the two in step
export interface GovernorConfig {
  $schema?: string | undefined
  /** Where task workspaces go; defaults to `<repo>.tasks` beside the repository */
  workspaceRoot?: string | undefined
  maxExecutors: number
  defaultBookmark: string
  roles: {
    coordinator: CoordinatorConfig
    executor: RoleConfig
    developer: RoleConfig
    reviewer: RoleConfig
  }
  env: { provider: EnvProvider; setup: string[] }
  globalChecks: { statement: string; check: string }[]
}

export const DEFAULT_CONFIG: GovernorConfig = v.parse(configSchema, {})

export interface LoadedConfig {
  config: GovernorConfig
  issues: string[]
}

// Not imported from tooling.ts: scripts/generate-schema.ts runs this file under Node, which cannot resolve `.js` imports of sources
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
  const parsed = v.safeParse(fileSchema, value)
  if (!parsed.success) {
    const details = parsed.issues.map(issue => `${v.getDotPath(issue) ?? '(root)'}: ${issue.message}`)
    issues.push(`${path}: ${details.join('; ')}`)

    return undefined
  }

  return parsed.output
}

export function configPaths(repoRoot: string): { global: string; project: string } {
  return {
    global: join(getAgentDir(), 'extensions', EXTENSION_ID, 'config.json'),
    project: join(repoRoot, '.pi', 'extensions', EXTENSION_ID, 'config.json'),
  }
}

/**
 * Project fields override global ones, role by role. An untrusted project's file is left unread, and an unusable
 * scope leaves the defaults in force rather than half a config
 */
export function loadConfig(repoRoot: string, projectTrusted: boolean): LoadedConfig {
  const paths = configPaths(repoRoot)
  const issues: string[] = []
  const global = readScope(paths.global, issues)
  const project = projectTrusted ? readScope(paths.project, issues) : {}
  if (global === undefined || project === undefined) {
    return { config: DEFAULT_CONFIG, issues }
  }
  const config = v.parse(configSchema, {
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
  const { $schema, ...schema } = toJsonSchema(configSchema, {
    target: 'draft-2020-12',
    typeMode: 'input',
    ignoreActions: ['trim'],
  })

  return { $schema, $id: CONFIG_SCHEMA_URL, ...schema }
}
