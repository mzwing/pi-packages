import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { z } from 'zod'

export const EXTENSION_ID = 'pi-codex-enhancer'
export const COMMAND_NAME = 'codex-enhancer'
const DEFAULT_PROVIDERS: string[] = ['openai-codex']
const PROXY_SCHEMES = ['http:', 'https:', 'socks5:', 'socks5h:']
const CONFIG_SCHEMA_URL =
  'https://raw.githubusercontent.com/mzwing/pi-packages/master/packages/pi-codex-enhancer/schemas/config.schema.json'

/** Syntax only, and never a network call. Ported from sub2api's harvest-proxy validation. */
export function proxyUrlProblem(raw: string): string | undefined {
  const value = raw.trim()
  if (value.length === 0) {
    return undefined
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return 'must be a URL'
  }
  if (!PROXY_SCHEMES.includes(parsed.protocol)) {
    return 'scheme must be http, https, socks5 or socks5h'
  }
  if (parsed.hostname.length === 0) {
    return 'must name a host'
  }
  if ((parsed.pathname !== '' && parsed.pathname !== '/') || parsed.search !== '' || parsed.hash !== '') {
    return 'must not carry a path, query or fragment'
  }
  if (parsed.port !== '' && (Number(parsed.port) < 1 || Number(parsed.port) > 65535)) {
    return 'port must be between 1 and 65535'
  }

  return undefined
}

/** So a password never reaches the terminal, a log or a bug report. */
export function maskProxyUrl(raw: string): string {
  const value = raw.trim()
  if (value.length === 0 || proxyUrlProblem(value) !== undefined) {
    return ''
  }
  const parsed = new URL(value)
  if (parsed.password !== '') {
    parsed.password = '***'
  }

  return parsed.toString()
}

const proxyUrlSchema = z
  .string()
  .refine(
    value => proxyUrlProblem(value) === undefined,
    'must be an http, https, socks5 or socks5h URL naming a host, with no path, query or fragment',
  )

const configFileShape = {
  $schema: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  providers: z.array(z.string().trim().min(1)).optional(),
  probeTimeoutMs: z.number().int().min(1000).max(30_000).optional(),
  minProbeIntervalMs: z.number().int().min(10_000).max(3_600_000).optional(),
  probeProxyUrl: proxyUrlSchema.optional(),
  notify: z.boolean().optional(),
}

const configFileSchema = z.strictObject(configFileShape)

const enhancerConfigSchema = z.strictObject({
  ...configFileShape,
  enabled: z.boolean().default(true),
  providers: z.array(z.string().trim().min(1)).default(DEFAULT_PROVIDERS),
  probeTimeoutMs: z.number().int().min(1000).max(30_000).default(8000),
  minProbeIntervalMs: z.number().int().min(10_000).max(3_600_000).default(60_000),
  probeProxyUrl: proxyUrlSchema.default(''),
  notify: z.boolean().default(true),
})

/**
 * Hand-written because `isolatedDeclarations` cannot emit a `z.infer` of a module-private schema.
 * `DEFAULT_CONFIG` below is the assignability check that keeps the two in step.
 */
export interface EnhancerConfig {
  $schema?: string | undefined
  enabled: boolean
  /** Provider ids to act on. An empty list acts on every provider that speaks the Codex api. */
  providers: string[]
  /** How long one provider request may be held while a ticket is minted. */
  probeTimeoutMs: number
  minProbeIntervalMs: number
  /** Egress for the probe only. Business requests keep Pi's own network path. */
  probeProxyUrl: string
  notify: boolean
}

export const DEFAULT_CONFIG: EnhancerConfig = enhancerConfigSchema.parse({})

interface EnhancerConfigFile {
  $schema?: string | undefined
  enabled?: boolean | undefined
  providers?: string[] | undefined
  probeTimeoutMs?: number | undefined
  minProbeIntervalMs?: number | undefined
  probeProxyUrl?: string | undefined
  notify?: boolean | undefined
}

interface ConfigIssue {
  sourcePath: string
  message: string
}

export interface EnhancerConfigPaths {
  globalPath: string
  projectPath: string
}

export interface LoadConfigResult {
  config: EnhancerConfig | undefined
  issues: ConfigIssue[]
  globalPath: string
  projectPath: string
}

export interface LoadConfigOptions {
  cwd: string
  agentDir?: string
  readFile?: (path: string) => string | undefined
}

export function defaultEnhancerAgentDir(): string {
  return process.env['PI_CODING_AGENT_DIR'] ?? join(homedir(), '.pi', 'agent')
}

export function getEnhancerConfigPaths(cwd: string, agentDir: string = defaultEnhancerAgentDir()): EnhancerConfigPaths {
  return {
    globalPath: join(agentDir, 'extensions', EXTENSION_ID, 'config.json'),
    projectPath: join(cwd, '.pi', 'extensions', EXTENSION_ID, 'config.json'),
  }
}

export function getTicketStorePath(agentDir: string = defaultEnhancerAgentDir()): string {
  return join(agentDir, 'extensions', EXTENSION_ID, 'tickets.json')
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
): EnhancerConfigFile | undefined {
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

export function loadEnhancerConfig(options: LoadConfigOptions): LoadConfigResult {
  const { globalPath, projectPath } = getEnhancerConfigPaths(options.cwd, options.agentDir)
  const readFile = options.readFile ?? readConfigFile
  const issues: ConfigIssue[] = []
  const globalConfig = readScope(globalPath, readFile, issues)
  const projectConfig = readScope(projectPath, readFile, issues)

  if (globalConfig === undefined || projectConfig === undefined) {
    return { config: undefined, issues, globalPath, projectPath }
  }

  const merged = enhancerConfigSchema.safeParse({ ...globalConfig, ...projectConfig })
  if (!merged.success) {
    issues.push({ sourcePath: projectPath, message: formatZodIssue(merged.error) })

    return { config: undefined, issues, globalPath, projectPath }
  }

  return { config: merged.data, issues, globalPath, projectPath }
}

export type PiTransport = 'sse' | 'websocket' | 'websocket-cached' | 'auto'

const TRANSPORTS: PiTransport[] = ['sse', 'websocket', 'websocket-cached', 'auto']

function readTransportScope(path: string, readFile: (path: string) => string | undefined): PiTransport | undefined {
  let source: string | undefined
  try {
    source = readFile(path)
  } catch {
    return undefined
  }
  if (source === undefined) {
    return undefined
  }

  try {
    const value: unknown = JSON.parse(source)
    const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

    return TRANSPORTS.find(candidate => candidate === record['transport'])
  } catch {
    return undefined
  }
}

/**
 * Pi's own transport, read from its settings rather than `ExtensionContext`, which does not carry
 * it. The injected header only reaches the backend on a fresh handshake, so anything but `sse`
 * leaves most requests untouched and the user has to be told.
 */
export function readPiTransport(options: LoadConfigOptions): PiTransport {
  const agentDir = options.agentDir ?? defaultEnhancerAgentDir()
  const readFile = options.readFile ?? readConfigFile

  return (
    readTransportScope(join(options.cwd, '.pi', 'settings.json'), readFile) ??
    readTransportScope(join(agentDir, 'settings.json'), readFile) ??
    'auto'
  )
}

export function buildEnhancerJsonSchema(): Record<string, unknown> {
  const { $schema, ...schema } = z.toJSONSchema(enhancerConfigSchema, { target: 'draft-2020-12', io: 'input' })

  return { $schema, $id: CONFIG_SCHEMA_URL, ...schema }
}
