import type { ActivationResult } from './command.js'
import type { LoadConfigResult } from './config-store.js'
import type { AutoReviewConfig } from './config.js'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type {
  Authorizer,
  AuthorizerVerdict,
  PermissionsReadyEvent,
  PermissionsService,
} from '@gotgenes/pi-permission-system'
import { existsSync } from 'node:fs'
import { getPermissionsService, PERMISSIONS_READY_CHANNEL } from '@gotgenes/pi-permission-system'
import { DenialCircuitBreaker } from './circuit-breaker.js'
import { registerAutoReviewCommand } from './command.js'
import { configPath, loadConfig } from './config-store.js'
import { EXTENSION_ID } from './config.js'
import { createPermissionReviewer } from './reviewer.js'

const AUTHORIZER_NAME = 'auto-review'
const VERDICT_LABELS = [
  ['allow', 'allowed'],
  ['deny', 'denied'],
  ['defer', 'deferred'],
] as const

type Tally = Record<AuthorizerVerdict['kind'], number>

/** One reviewer per applied config, so a config change swaps the registered link without a reload. */
interface Generation {
  /** The session's live context: `signal` and `ui` are read when used, not when the generation is made. */
  runtime: Pick<ExtensionContext, 'modelRegistry' | 'sessionManager' | 'signal' | 'ui'>
  config: AutoReviewConfig | undefined
  controller: AbortController
  authorize: Authorizer['authorize']
  dispose: (() => void) | undefined
}

const deferInvalidConfig: Authorizer['authorize'] = async (details, _query, log) => {
  log.review('auto_review.decision', {
    requestId: details.requestId,
    outcome: 'defer',
    errorCategory: 'config-invalid',
  })

  return { kind: 'defer' }
}

function warn(message: string): void {
  console.warn(`[${EXTENSION_ID}] ${message}`)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function statusText(current: Generation, tally: Tally): string {
  if (current.config === undefined) {
    return `${AUTHORIZER_NAME} inactive: invalid config`
  }
  if (current.dispose === undefined) {
    return `${AUTHORIZER_NAME} inactive`
  }
  const counts = VERDICT_LABELS.flatMap(([kind, label]) => (tally[kind] > 0 ? [`${tally[kind]} ${label}`] : []))

  return [`${AUTHORIZER_NAME} ready`, ...counts].join(' · ')
}

export default function permissionAutoReview(pi: ExtensionAPI): void {
  const circuitBreaker = new DenialCircuitBreaker()
  let generation: Generation | undefined
  let tally: Tally = { allow: 0, deny: 0, defer: 0 }
  // One process hosts a node per session and subagent, and a link is only read by the node it registered in.
  let sessionId: string | undefined
  let warnedMissingSessionId = false

  function renderStatus(current: Generation): void {
    current.runtime.ui.setStatus(EXTENSION_ID, statusText(current, tally))
  }

  function createGeneration(runtime: Generation['runtime'], config: AutoReviewConfig | undefined): Generation {
    const controller = new AbortController()
    const review =
      config === undefined
        ? deferInvalidConfig
        : createPermissionReviewer({ config, context: runtime, circuitBreaker, sessionSignal: controller.signal })
    const created: Generation = {
      runtime,
      config,
      controller,
      authorize: async (details, query, log) => {
        const verdict = await review(details, query, log)
        // A retired generation answers for a session or config that is gone.
        if (generation === created) {
          tally[verdict.kind] += 1
          renderStatus(created)
        }

        return verdict
      },
      dispose: undefined,
    }

    return created
  }

  /** Throws when the service refuses the link, leaving `target` unregistered. */
  function register(target: Generation, service: PermissionsService): void {
    target.dispose = service.registerAuthorizer(AUTHORIZER_NAME, target.authorize)
    renderStatus(target)
  }

  function retire(retired: Generation | undefined): void {
    retired?.dispose?.()
    retired?.controller.abort()
    circuitBreaker.resetTurn()
  }

  function reportIssues(issues: string[]): void {
    for (const issue of issues) {
      warn(`config issue at ${issue}`)
    }
  }

  function applyConfig(result: LoadConfigResult): ActivationResult {
    reportIssues(result.issues)
    // Commands only run inside a started session.
    const current = generation!
    if (result.config === undefined) {
      return { kind: 'failed', message: 'the merged config is invalid; the previous reviewer remains active' }
    }
    const service = sessionId === undefined ? undefined : getPermissionsService(sessionId)
    if (service === undefined && current.dispose !== undefined) {
      // Without the service the old link cannot be released, and dropping its handle would leave it deciding
      // under the superseded config for the rest of the session.
      return {
        kind: 'failed',
        message: 'pi-permission-system became unavailable while the old reviewer was still registered',
      }
    }

    const candidate = createGeneration(current.runtime, result.config)
    retire(current)
    generation = candidate
    renderStatus(candidate)
    if (service === undefined) {
      return { kind: 'pending' }
    }
    try {
      register(candidate, service)
    } catch (error) {
      // Nothing is registered now, so asks fall through to the human prompt and the next ready retries.
      return { kind: 'failed', message: `the new reviewer could not be registered: ${describeError(error)}` }
    }

    return { kind: 'active' }
  }

  pi.on('session_start', (_event, ctx) => {
    retire(generation)
    const projectTrusted = ctx.isProjectTrusted()
    const result = loadConfig(ctx.cwd, projectTrusted)
    reportIssues(result.issues)
    const projectPath = configPath(ctx.cwd, 'project')
    if (!projectTrusted && existsSync(projectPath)) {
      warn(`${projectPath} is ignored until Pi trusts this project`)
    }
    tally = { allow: 0, deny: 0, defer: 0 }
    generation = createGeneration(ctx, result.config)
    renderStatus(generation)
  })

  // Registration happens only here: ready fires after every `session_start` and before any ask, and may
  // repeat, which the stored dispose handle turns into a no-op.
  pi.events.on(PERMISSIONS_READY_CHANNEL, data => {
    const ready = data as PermissionsReadyEvent
    if (ready.sessionId === null) {
      if (!warnedMissingSessionId) {
        warnedMissingSessionId = true
        warn(`pi-permission-system published no keyed service for this node; ${AUTHORIZER_NAME} stays unregistered`)
      }

      return
    }
    sessionId ??= ready.sessionId
    const service = getPermissionsService(sessionId)
    if (generation === undefined || generation.dispose !== undefined || service === undefined) {
      return
    }
    try {
      register(generation, service)
    } catch (error) {
      warn(`failed to register ${AUTHORIZER_NAME}: ${describeError(error)}`)
    }
  })

  pi.on('turn_start', () => {
    circuitBreaker.resetTurn()
  })

  pi.on('session_shutdown', (_event, ctx) => {
    ctx.ui.setStatus(EXTENSION_ID, undefined)
    retire(generation)
    generation = undefined
    sessionId = undefined
    warnedMissingSessionId = false
  })

  registerAutoReviewCommand(pi, { getActiveConfig: () => generation?.config, applyConfig })
}
