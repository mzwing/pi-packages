import type { DetectorConfig, DetectorConfigPaths, LoadConfigResult } from './config.js'
import type { IdentityResolver } from './identity.js'
import type { HeaderObservation } from './observe.js'
import type { Verdict } from './verdict.js'
import type { ExtensionAPI, ModelRegistry } from '@earendil-works/pi-coding-agent'
import { registerDetectorCommand } from './command.js'
import {
  DEFAULT_CONFIG,
  defaultDetectorAgentDir,
  EXTENSION_ID,
  getDetectorConfigPaths,
  loadDetectorConfig,
} from './config.js'
import { createIdentityResolver } from './identity.js'
import {
  buildTurnObservation,
  observeAssistantMessage,
  observeRequestPayload,
  observeResponseHeaders,
} from './observe.js'
import { renderAlert, renderStatus } from './render.js'
import { isSubstitution, judgeTurn } from './verdict.js'

/** How many judged turns `/codex-downgrade` can report on. */
const HISTORY_LIMIT = 50

export interface DetectorExtensionDependencies {
  loadConfig?: ((cwd: string, agentDir: string) => LoadConfigResult) | undefined
  agentDir?: string | undefined
  warn?: ((message: string) => void) | undefined
}

function defaultWarn(message: string): void {
  console.warn(`[${EXTENSION_ID}] ${message}`)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Slugs the provider can actually offer, so a relay-added model is not called a stranger. */
function registrySlugs(registry: ModelRegistry, providers: readonly string[]): string[] {
  try {
    return registry
      .getAll()
      .filter(model => providers.length === 0 || providers.includes(model.provider))
      .map(model => model.id)
  } catch {
    return []
  }
}

/**
 * What the selected level maps to for this model. A `null` entry marks the level unsupported, so
 * Pi substitutes one of its own — there is nothing to compare against and no finding to make.
 */
function expectedEffortFor(
  registry: ModelRegistry,
  provider: string,
  modelId: string,
  level: string | undefined,
): string | undefined {
  if (level === undefined) {
    return undefined
  }
  const levelMap = registry.find(provider, modelId)?.thinkingLevelMap ?? {}
  const entry = Object.entries(levelMap).find(([key]) => key === level)
  if (entry === undefined) {
    return level
  }

  return entry[1] === null ? undefined : entry[1]
}

export function createDetectorExtension(pi: ExtensionAPI, dependencies: DetectorExtensionDependencies = {}): void {
  const warn = dependencies.warn ?? defaultWarn
  const agentDir = dependencies.agentDir ?? defaultDetectorAgentDir()
  const loadConfig = dependencies.loadConfig ?? ((cwd, dir) => loadDetectorConfig({ cwd, agentDir: dir }))

  let config: DetectorConfig = DEFAULT_CONFIG
  let paths: DetectorConfigPaths | undefined
  let resolver: IdentityResolver = createIdentityResolver()
  let registry: ModelRegistry | undefined
  let verdicts: Verdict[] = []
  let pendingHeaders: HeaderObservation | undefined
  let pendingEffort: string | undefined
  let selectedEffort: string | undefined
  const notified = new Set<string>()

  function reset(): void {
    verdicts = []
    pendingHeaders = undefined
    pendingEffort = undefined
    selectedEffort = undefined
    notified.clear()
  }

  function watches(provider: string): boolean {
    return config.providers.length === 0 || config.providers.includes(provider)
  }

  pi.on('session_start', (_event, context) => {
    reset()
    registry = context.modelRegistry
    paths = getDetectorConfigPaths(context.cwd, agentDir)

    const loaded = loadConfig(context.cwd, agentDir)
    for (const issue of loaded.issues) {
      warn(`config issue at ${issue.sourcePath}: ${issue.message}`)
    }
    config = loaded.config ?? DEFAULT_CONFIG
    resolver = createIdentityResolver({
      tiers: config.tiers,
      registrySlugs: registrySlugs(context.modelRegistry, config.providers),
    })
    context.ui.setStatus(EXTENSION_ID, undefined)
  })

  pi.on('before_provider_request', (event, context) => {
    pendingEffort = observeRequestPayload(event.payload)
    selectedEffort = context.thinkingLevel
  })

  pi.on('after_provider_response', event => {
    pendingHeaders = observeResponseHeaders(event.status, event.headers)
  })

  pi.on('message_end', (event, context) => {
    const assistant = observeAssistantMessage(event.message)
    const headers = pendingHeaders
    const sentEffort = pendingEffort
    pendingHeaders = undefined
    pendingEffort = undefined

    if (assistant === undefined || !watches(assistant.provider)) {
      return
    }

    try {
      const effort =
        config.checkEffort && registry !== undefined
          ? {
              selectedEffort,
              sentEffort,
              expectedEffort: expectedEffortFor(registry, assistant.provider, assistant.requestedModel, selectedEffort),
            }
          : {}
      const turn = buildTurnObservation({ assistant, headers, ...effort })
      const verdict = judgeTurn(turn, resolver)

      verdicts.push(verdict)
      if (verdicts.length > HISTORY_LIMIT) {
        verdicts.shift()
      }
      context.ui.setStatus(EXTENSION_ID, renderStatus(verdict, context.ui.theme))

      const pair = `${turn.requestedModel}->${turn.servedModel ?? '(none)'}`
      if (config.notify && isSubstitution(verdict) && !notified.has(pair)) {
        notified.add(pair)
        context.ui.notify(renderAlert(verdict), 'error')
      }
    } catch (error) {
      warn(`could not judge this turn: ${describeError(error)}`)
    }
  })

  pi.on('session_shutdown', (_event, context) => {
    context.ui.setStatus(EXTENSION_ID, undefined)
    reset()
  })

  registerDetectorCommand(pi, {
    getVerdicts: () => verdicts,
    getConfig: () => config,
    getPaths: () => paths,
  })
}
