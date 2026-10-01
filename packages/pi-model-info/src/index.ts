import type { CatalogSnapshot } from './catalog.js'
import type { ResolvedConfig } from './types.js'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { CatalogStore } from './catalog.js'
import { buildCompletions, COMMAND_NAME, formatDetail, formatSummary } from './command.js'
import { loadConfig } from './config.js'
import { ProviderApplier } from './provider-apply.js'
import { describeError, warn } from './util.js'

export default function modelInfo(pi: ExtensionAPI): void {
  const store = new CatalogStore()
  const applier = new ProviderApplier(pi)
  let config: ResolvedConfig | undefined
  let issues: string[] = []
  let catalog: CatalogSnapshot | undefined
  let pending: CatalogSnapshot | undefined
  let session: AbortController | undefined
  let isIdle = (): boolean => true

  function applyCatalog(snapshot: CatalogSnapshot): void {
    // A contextWindow changing mid-turn can flip a compaction decision, so the swap waits for the turn to end.
    // A lazily completed provider reads whatever catalog is in force, so holding it back here covers that too.
    if (config?.applyOnIdleOnly === true && !isIdle()) {
      pending = snapshot

      return
    }
    pending = undefined
    catalog = snapshot
    applier.apply(snapshot)
  }

  // A discovery extension registers from its factory, which Pi flushes before any session event, so capturing
  // here completes its models rather than racing them.
  pi.on('session_start', (_event, ctx) => {
    session?.abort()
    session = undefined
    pending = undefined
    catalog = undefined
    isIdle = () => ctx.isIdle()

    const loaded = loadConfig(ctx.cwd)
    issues = loaded.issues
    for (const issue of issues) {
      warn(`config issue at ${issue}`)
    }
    config = loaded.config
    if (config === undefined) {
      return
    }
    applier.capture(ctx.modelRegistry, config)
    if (config.providers.size === 0) {
      return
    }

    const resolved = config
    const controller = new AbortController()
    session = controller
    // Catalog I/O stays off `session_start`, which Pi awaits.
    setTimeout(() => {
      const run = async (): Promise<void> => {
        if (controller.signal.aborted) {
          return
        }
        applyCatalog(store.load(resolved))
        const refreshed = await store.refresh(resolved, controller.signal)
        if (!controller.signal.aborted) {
          applyCatalog(refreshed)
        }
      }
      run().catch((error: unknown) => {
        warn(`catalog refresh failed: ${describeError(error)}`)
      })
    }, 0)
  })

  pi.on('before_agent_start', (_event, ctx) => {
    if (config !== undefined && catalog !== undefined && applier.reconcile(ctx.modelRegistry)) {
      applier.apply(catalog)
    }
  })

  pi.on('turn_end', () => {
    if (pending !== undefined) {
      catalog = pending
      pending = undefined
      applier.apply(catalog)
    }
  })

  pi.on('session_shutdown', () => {
    session?.abort()
    session = undefined
    pending = undefined
  })

  pi.registerCommand(COMMAND_NAME, {
    description: 'Inspect the model metadata pi-model-info resolved for your third-party providers',
    getArgumentCompletions: prefix => buildCompletions(applier.getReports(), prefix),
    async handler(args, ctx) {
      const argument = args.trim()
      if (argument === 'refresh' && config !== undefined) {
        applyCatalog(await store.refresh(config, new AbortController().signal, true))
      }
      if (argument === 'refresh' || argument === '') {
        ctx.ui.notify(formatSummary(applier.getReports(), catalog, issues, Date.now()), 'info')

        return
      }
      ctx.ui.notify(
        formatDetail(applier.getReports(), argument, (providerId, modelId) =>
          ctx.modelRegistry.find(providerId, modelId),
        ),
        'info',
      )
    },
  })
}
