import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { z } from 'zod'

export const EXTENSION_ID = 'pi-codex-downgrade-detector'
export const COMMAND_NAME = 'codex-downgrade'
const DEFAULT_PROVIDERS: string[] = ['openai-codex']
const CONFIG_SCHEMA_URL =
  'https://raw.githubusercontent.com/mzwing/pi-packages/master/packages/pi-codex-downgrade-detector/schemas/config.schema.json'

const configFileShape = {
  $schema: z.string().min(1).optional(),
  providers: z.array(z.string().trim().min(1)).optional(),
  tiers: z.record(z.string().trim().min(1), z.number().int()).optional(),
  checkEffort: z.boolean().optional(),
  notify: z.boolean().optional(),
}

const configFileSchema = z.strictObject(configFileShape)

const detectorConfigSchema = z.strictObject({
  ...configFileShape,
  providers: z.array(z.string().trim().min(1)).default(DEFAULT_PROVIDERS),
  tiers: z.record(z.string().trim().min(1), z.number().int()).default({}),
  checkEffort: z.boolean().default(true),
  notify: z.boolean().default(true),
})

/**
 * Hand-written because `isolatedDeclarations` cannot emit a `z.infer` of a module-private schema.
 * `DEFAULT_CONFIG` below is the assignability check that keeps the two in step.
 */
export interface DetectorConfig {
  $schema?: string | undefined
  /** Provider ids to watch. An empty list watches every provider. */
  providers: string[]
  /** `slug -> rank`, higher meaning more capable. Extends the built-in table. */
  tiers: Record<string, number>
  checkEffort: boolean
  notify: boolean
}

export const DEFAULT_CONFIG: DetectorConfig = detectorConfigSchema.parse({})

interface DetectorConfigFile {
  $schema?: string | undefined
  providers?: string[] | undefined
  tiers?: Record<string, number> | undefined
  checkEffort?: boolean | undefined
  notify?: boolean | undefined
}

interface ConfigIssue {
  sourcePath: string
  message: string
}

export interface DetectorConfigPaths {
  globalPath: string
  projectPath: string
}

export interface LoadConfigResult {
  config: DetectorConfig | undefined
  issues: ConfigIssue[]
  globalPath: string
  projectPath: string
}

export interface LoadConfigOptions {
  cwd: string
  agentDir?: string
  readFile?: (path: string) => string | undefined
}

export function defaultDetectorAgentDir(): string {
  return process.env['PI_CODING_AGENT_DIR'] ?? join(homedir(), '.pi', 'agent')
}

export function getDetectorConfigPaths(cwd: string, agentDir: string = defaultDetectorAgentDir()): DetectorConfigPaths {
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
): DetectorConfigFile | undefined {
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

export function loadDetectorConfig(options: LoadConfigOptions): LoadConfigResult {
  const { globalPath, projectPath } = getDetectorConfigPaths(options.cwd, options.agentDir)
  const readFile = options.readFile ?? readConfigFile
  const issues: ConfigIssue[] = []
  const globalConfig = readScope(globalPath, readFile, issues)
  const projectConfig = readScope(projectPath, readFile, issues)

  if (globalConfig === undefined || projectConfig === undefined) {
    return { config: undefined, issues, globalPath, projectPath }
  }

  // `tiers` merges across scopes: a project file that ranks one new slug should not
  // discard the ranks the global file established.
  const merged = detectorConfigSchema.safeParse({
    ...globalConfig,
    ...projectConfig,
    tiers: { ...globalConfig.tiers, ...projectConfig.tiers },
  })
  if (!merged.success) {
    issues.push({ sourcePath: projectPath, message: formatZodIssue(merged.error) })

    return { config: undefined, issues, globalPath, projectPath }
  }

  return { config: merged.data, issues, globalPath, projectPath }
}

export function buildDetectorJsonSchema(): Record<string, unknown> {
  const { $schema, ...schema } = z.toJSONSchema(detectorConfigSchema, { target: 'draft-2020-12', io: 'input' })

  return { $schema, $id: CONFIG_SCHEMA_URL, ...schema }
}
