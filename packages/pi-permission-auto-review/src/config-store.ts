import type { AutoReviewConfig, AutoReviewConfigFile } from './config.js'
import { mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { CONFIG_SCHEMA_URL, EXTENSION_ID, mergeConfig, parseConfigFile, validateConfigFile } from './config.js'

export type ConfigScope = 'global' | 'project'

export type ScopeSnapshot = { scope: ConfigScope; cwd: string; path: string; source: string | undefined } & (
  | { valid: true; config: AutoReviewConfigFile }
  | { valid: false; issue: string }
)

export interface LoadConfigResult {
  config: AutoReviewConfig | undefined
  issues: string[]
}

export type ConfigMutationResult = { ok: true; loadResult: LoadConfigResult } | { ok: false; message: string }

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function configPath(cwd: string, scope: ConfigScope): string {
  return scope === 'global'
    ? join(getAgentDir(), 'extensions', EXTENSION_ID, 'config.json')
    : join(cwd, '.pi', 'extensions', EXTENSION_ID, 'config.json')
}

function readSource(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

export function readScope(cwd: string, scope: ConfigScope): ScopeSnapshot {
  const path = configPath(cwd, scope)
  let source: string | undefined
  try {
    source = readSource(path)
  } catch (error) {
    return { scope, cwd, path, source: undefined, valid: false, issue: describeError(error) }
  }
  if (source === undefined) {
    return { scope, cwd, path, source, valid: true, config: {} }
  }
  const parsed = parseConfigFile(source)

  return parsed.ok
    ? { scope, cwd, path, source, valid: true, config: parsed.config }
    : { scope, cwd, path, source, valid: false, issue: parsed.issue }
}

/** The scope as it takes part in the merge: an untrusted project's file is left unread, so it can neither loosen nor break the config. */
export function readActiveScope(cwd: string, scope: ConfigScope, projectTrusted: boolean): ScopeSnapshot {
  return scope === 'project' && !projectTrusted
    ? { scope, cwd, path: configPath(cwd, scope), source: undefined, valid: true, config: {} }
    : readScope(cwd, scope)
}

function merge(global: ScopeSnapshot, project: ScopeSnapshot): LoadConfigResult {
  if (!global.valid || !project.valid) {
    const issues = [global, project].flatMap(snapshot => (snapshot.valid ? [] : `${snapshot.path}: ${snapshot.issue}`))

    return { config: undefined, issues }
  }
  const merged = mergeConfig(global.config, project.config)

  return merged.ok
    ? { config: merged.config, issues: [] }
    : { config: undefined, issues: [`${project.path}: ${merged.issue}`] }
}

export function loadConfig(cwd: string, projectTrusted: boolean): LoadConfigResult {
  return merge(readScope(cwd, 'global'), readActiveScope(cwd, 'project', projectTrusted))
}

function checkForConflict(snapshot: ScopeSnapshot): string | undefined {
  let current: string | undefined
  try {
    current = readSource(snapshot.path)
  } catch (error) {
    return `Failed to re-read config at '${snapshot.path}': ${describeError(error)}`
  }

  return current === snapshot.source
    ? undefined
    : `Config at '${snapshot.path}' changed while it was being edited; reopen the command and try again.`
}

export function saveScope(
  snapshot: ScopeSnapshot,
  draft: AutoReviewConfigFile,
  projectTrusted: boolean,
): ConfigMutationResult {
  if (!snapshot.valid) {
    return { ok: false, message: `Cannot save invalid config at '${snapshot.path}': ${snapshot.issue}` }
  }
  const validated = validateConfigFile(draft)
  if (!validated.ok) {
    return { ok: false, message: `${snapshot.path}: ${validated.issue}` }
  }

  const { $schema = CONFIG_SCHEMA_URL, ...fields } = validated.config
  const config = { $schema, ...fields }
  const source = `${JSON.stringify(config, null, 2)}\n`
  const replacement: ScopeSnapshot = { ...snapshot, source, config }
  const other = readActiveScope(snapshot.cwd, snapshot.scope === 'global' ? 'project' : 'global', projectTrusted)
  const loadResult = snapshot.scope === 'global' ? merge(replacement, other) : merge(other, replacement)
  if (loadResult.config === undefined) {
    return { ok: false, message: loadResult.issues.join('\n') }
  }
  const conflict = checkForConflict(snapshot)
  if (conflict !== undefined) {
    return { ok: false, message: conflict }
  }

  const temporary = `${snapshot.path}.tmp`
  try {
    mkdirSync(dirname(snapshot.path), { recursive: true })
    writeFileSync(temporary, source, 'utf8')
    renameSync(temporary, snapshot.path)
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // The write error is the actionable one.
    }

    return { ok: false, message: `Failed to save config at '${snapshot.path}': ${describeError(error)}` }
  }

  return { ok: true, loadResult }
}

export function resetScope(snapshot: ScopeSnapshot, projectTrusted: boolean): ConfigMutationResult {
  if (!snapshot.valid && snapshot.source === undefined) {
    return { ok: false, message: `Cannot reset unreadable config at '${snapshot.path}': ${snapshot.issue}` }
  }
  const conflict = checkForConflict(snapshot)
  if (conflict !== undefined) {
    return { ok: false, message: conflict }
  }
  if (snapshot.source !== undefined) {
    try {
      unlinkSync(snapshot.path)
    } catch (error) {
      return { ok: false, message: `Failed to reset config at '${snapshot.path}': ${describeError(error)}` }
    }
  }

  return { ok: true, loadResult: loadConfig(snapshot.cwd, projectTrusted) }
}
