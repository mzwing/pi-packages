import type { CatalogSnapshot } from './catalog.js'
import type { ConfigIssue, LoadConfigResult } from './config.js'
import type { UserAuthoredMap } from './models-json.js'
import type { ResolvedConfig, SnapshotModel } from './types.js'
import type { ExtensionAPI, ModelRegistry } from '@earendil-works/pi-coding-agent'
import { CatalogStore } from './catalog.js'
import { registerModelInfoCommand } from './command.js'
import { defaultModelInfoAgentDir, EXTENSION_ID, loadModelInfoConfig, resolveModelInfoConfig } from './config.js'
import { readUserAuthoredFields } from './models-json.js'
import { ProviderApplier } from './provider-apply.js'

export interface ModelInfoExtensionDependencies {
  catalogStore?: CatalogStore | undefined
  applier?: ProviderApplier | undefined
  loadConfig?: ((cwd: string, agentDir: string) => LoadConfigResult) | undefined
  readUserAuthored?: ((agentDir: string) => UserAuthoredMap) | undefined
  agentDir?: string | undefined
  /** Defers all I/O off the extension factory and off `session_start`. */
  schedule?: ((task: () => void) => void) | undefined
  warn?: ((message: string) => void) | undefined
}

function defaultWarn(message: string): void {
  console.warn(`[${EXTENSION_ID}] ${message}`)
}

export function createModelInfoExtension(pi: ExtensionAPI, dependencies: ModelInfoExtensionDependencies = {}): void {
  const warn = dependencies.warn ?? defaultWarn
  const agentDir = dependencies.agentDir ?? defaultModelInfoAgentDir()
  const loadConfig = dependencies.loadConfig ?? ((cwd, dir) => loadModelInfoConfig({ cwd, agentDir: dir }))
  const readUserAuthored = dependencies.readUserAuthored ?? (dir => readUserAuthoredFields(dir))
  const schedule =
    dependencies.schedule ??
    (task => {
      setTimeout(task, 0)
    })
  const store = dependencies.catalogStore ?? new CatalogStore()
  const applier = dependencies.applier ?? new ProviderApplier({ warn })

  let config: ResolvedConfig | undefined
  let issues: ConfigIssue[] = []
  let registry: ModelRegistry | undefined
  let userAuthored: UserAuthoredMap = new Map()
  let catalog: CatalogSnapshot | undefined
  let pending: CatalogSnapshot | undefined
  let session: AbortController | undefined
  let isIdle: () => boolean = () => true

  function applyCatalog(snapshot: CatalogSnapshot): void {
    if (config === undefined) {
      return
    }
    // A contextWindow that changes mid-turn can flip a compaction decision, so by default the swap
    // waits for the turn to finish. A lazily completed provider reads whatever catalog is in force
    // at the moment Pi asks it for models, so holding the swap back here is what keeps that promise
    // for it too.
    if (config.applyOnIdleOnly && !isIdle()) {
      pending = snapshot

      return
    }
    pending = undefined
    catalog = snapshot
    applier.apply(pi, config, snapshot, userAuthored)
  }

  async function run(signal: AbortSignal): Promise<void> {
    if (config === undefined) {
      return
    }
    applyCatalog(store.load(config))
    if (signal.aborted) {
      return
    }
    const refreshed = await store.refresh(config, signal)
    if (!signal.aborted) {
      applyCatalog(refreshed)
    }
  }

  function start(): void {
    const controller = new AbortController()
    session = controller
    schedule(() => {
      void run(controller.signal).catch(error => {
        warn(`catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    })
  }

  // Synchronous by contract: `initializeExtension` awaits the factory, and a discovery extension's
  // registration is flushed before any session event — so staying out of the factory is also what
  // guarantees we complete its models rather than racing them.
  pi.on('session_start', (_event, context) => {
    session?.abort()
    session = undefined
    pending = undefined
    catalog = undefined
    registry = context.modelRegistry
    isIdle = () => context.isIdle()

    const loaded = loadConfig(context.cwd, agentDir)
    const resolved = loaded.config === undefined ? undefined : resolveModelInfoConfig(loaded.config, loaded.globalPath)
    issues = [...loaded.issues, ...(resolved?.issues ?? [])]
    for (const issue of issues) {
      warn(`config issue at ${issue.sourcePath}: ${issue.message}`)
    }

    config = resolved?.config
    if (config === undefined) {
      return
    }

    applier.releaseStale(pi, context.modelRegistry, config)
    if (config.providers.size === 0) {
      return
    }

    // Read before capturing: which models models.json defines is part of choosing a strategy.
    userAuthored = readUserAuthored(agentDir)
    applier.capture(context.modelRegistry, config, userAuthored)
    start()
  })

  pi.on('before_agent_start', (_event, context) => {
    if (config === undefined || catalog === undefined || registry === undefined) {
      return
    }
    isIdle = () => context.isIdle()
    if (applier.reconcile(registry)) {
      applier.apply(pi, config, catalog, userAuthored)
    }
  })

  pi.on('turn_end', () => {
    if (pending !== undefined && config !== undefined) {
      catalog = pending
      applier.apply(pi, config, pending, userAuthored)
    }
    pending = undefined
  })

  pi.on('session_shutdown', () => {
    session?.abort()
    session = undefined
    pending = undefined
  })

  registerModelInfoCommand(pi, {
    getReports: () => applier.getReports(),
    getCatalog: () => catalog,
    getIssues: () => issues,
    getEffectiveModel: (providerId, modelId): SnapshotModel | undefined => registry?.find(providerId, modelId),
    refresh: async () => {
      if (config === undefined) {
        return
      }
      applyCatalog(await store.refresh(config, new AbortController().signal, true))
    },
  })
}
