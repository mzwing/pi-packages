import type { HeaderObservation } from './observe.js'
import type { Verdict } from './verdict.js'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ModelRegistry } from '@earendil-works/pi-coding-agent'
import { configPaths, DEFAULT_CONFIG, EXTENSION_ID, loadConfig } from './config.js'
import { createIdentityResolver } from './identity.js'
import { observeHeaders, observeSentEffort, observeTurn } from './observe.js'
import { renderAlert, renderConfig, renderDetail, renderReport, renderStatus, renderWaitingStatus } from './render.js'
import { isSubstitution, judgeTurn } from './verdict.js'

const COMMAND_NAME = 'codex-downgrade'
const HISTORY_LIMIT = 50

/** A `null` entry marks the level unsupported: Pi substitutes one of its own, so there is nothing to compare. */
function expectedEffort(registry: ModelRegistry, message: AssistantMessage): string | undefined {
  if (message.thinkingLevel === undefined) {
    return undefined
  }
  const mapped = registry.find(message.provider, message.model)?.thinkingLevelMap?.[message.thinkingLevel]

  return mapped === null ? undefined : (mapped ?? message.thinkingLevel)
}

export default function codexDowngradeDetector(pi: ExtensionAPI): void {
  let config = DEFAULT_CONFIG
  let identify = createIdentityResolver({}, [])
  let verdicts: Verdict[] = []
  let pendingHeaders: HeaderObservation | undefined
  let pendingEffort: string | undefined
  const notified = new Set<string>()

  function reset(): void {
    verdicts = []
    pendingHeaders = undefined
    pendingEffort = undefined
    notified.clear()
  }

  function watches(provider: string): boolean {
    return config.providers.length === 0 || config.providers.includes(provider)
  }

  pi.on('session_start', (_event, ctx) => {
    reset()
    const loaded = loadConfig(ctx.cwd)
    for (const issue of loaded.issues) {
      console.warn(`[${EXTENSION_ID}] config issue at ${issue}`)
    }
    config = loaded.config
    // Slugs the provider can actually offer, so a relay-added model is not called a stranger.
    const offered = ctx.modelRegistry
      .getAll()
      .filter(model => watches(model.provider))
      .map(model => model.id)
    identify = createIdentityResolver(config.tiers, offered)
    ctx.ui.setStatus(EXTENSION_ID, renderWaitingStatus(ctx.ui.theme))
    ctx.ui.setWidget(EXTENSION_ID, undefined)
  })

  pi.on('before_provider_request', event => {
    pendingEffort = observeSentEffort(event.payload)
  })

  pi.on('after_provider_response', event => {
    pendingHeaders = observeHeaders(event.headers)
  })

  pi.on('message_end', (event, ctx) => {
    const { message } = event
    const headers = pendingHeaders
    const sentEffort = pendingEffort
    pendingHeaders = undefined
    pendingEffort = undefined
    // A turn a virtual model failed to route never reached a provider.
    if (message.role !== 'assistant' || message.api === 'pi-virtual' || !watches(message.provider)) {
      return
    }

    const turn = observeTurn({
      message,
      headers,
      sentEffort,
      expectedEffort: config.checkEffort ? expectedEffort(ctx.modelRegistry, message) : undefined,
    })
    const verdict = judgeTurn(turn, identify)
    verdicts.push(verdict)
    if (verdicts.length > HISTORY_LIMIT) {
      verdicts.shift()
    }
    ctx.ui.setStatus(EXTENSION_ID, renderStatus(verdict, ctx.ui.theme))
    ctx.ui.setWidget(EXTENSION_ID, renderDetail(verdict, ctx.ui.theme))

    const pair = `${turn.requestedModel}->${turn.servedModel}`
    if (config.notify && isSubstitution(verdict) && !notified.has(pair)) {
      notified.add(pair)
      ctx.ui.notify(renderAlert(verdict), 'error')
    }
  })

  pi.on('session_shutdown', (_event, ctx) => {
    ctx.ui.setStatus(EXTENSION_ID, undefined)
    ctx.ui.setWidget(EXTENSION_ID, undefined)
    reset()
  })

  pi.registerCommand(COMMAND_NAME, {
    description: 'Report which model actually served each turn in this session',
    getArgumentCompletions: prefix =>
      'show'.startsWith(prefix.trim())
        ? [{ value: 'show', label: 'show', description: 'Show the resolved config and where it came from' }]
        : null,
    handler: async (args, ctx) => {
      const argument = args.trim().toLowerCase()
      if (argument === '') {
        ctx.ui.notify(renderReport(verdicts), 'info')
      } else if (argument === 'show') {
        ctx.ui.notify(renderConfig(config, configPaths(ctx.cwd)), 'info')
      } else {
        ctx.ui.notify(`Usage: /${COMMAND_NAME} [show]`, 'warning')
      }
    },
  })
}
