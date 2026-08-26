import type { AutoReviewActivationResult } from './command.js'
import type { AutoReviewConfig, LoadConfigResult } from './config.js'
import type { ExtensionAPI, ModelRegistry, SessionManager } from '@earendil-works/pi-coding-agent'
import type { Authorizer, PermissionsReadyEvent, PermissionsService } from '@gotgenes/pi-permission-system'
import {
  getPermissionsService as getKeyedPermissionsService,
  PERMISSIONS_READY_CHANNEL,
} from '@gotgenes/pi-permission-system'
import { DenialCircuitBreaker } from './circuit-breaker.js'
import { registerAutoReviewCommand } from './command.js'
import { AutoReviewConfigStore } from './config-store.js'
import { AUTHORIZER_NAME, EXTENSION_ID } from './config.js'
import { createPermissionReviewer } from './reviewer.js'

interface SessionRuntime {
  registry: ModelRegistry
  sessionManager: Pick<SessionManager, 'getBranch'>
}

interface ReviewerFactoryOptions extends SessionRuntime {
  config: AutoReviewConfig
  circuitBreaker: DenialCircuitBreaker
  sessionSignal: AbortSignal
}

export interface AutoReviewExtensionDependencies {
  configStore?: AutoReviewConfigStore
  getPermissionsService?: (sessionId: string) => PermissionsService | undefined
  createReviewer?: (options: ReviewerFactoryOptions) => Authorizer['authorize']
}

interface ReviewerGeneration {
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

export function createAutoReviewExtension(pi: ExtensionAPI, dependencies: AutoReviewExtensionDependencies = {}): void {
  const configStore = dependencies.configStore ?? new AutoReviewConfigStore()
  const getPermissionsService = dependencies.getPermissionsService ?? getKeyedPermissionsService
  const createReviewer = dependencies.createReviewer ?? createPermissionReviewer

  const circuitBreaker = new DenialCircuitBreaker()
  let sessionRuntime: SessionRuntime | undefined
  let generation: ReviewerGeneration | undefined
  // The key for the keyed locator, learned from `permissions:ready`. One Pi
  // process hosts several nodes — a root session and each in-process subagent
  // child — and a chain link is only read by the node it was registered in.
  let sessionId: string | undefined
  let warnedMissingSessionId = false

  function createGeneration(runtime: SessionRuntime, config: AutoReviewConfig | undefined): ReviewerGeneration {
    const controller = new AbortController()
    return {
      config,
      controller,
      authorize:
        config === undefined
          ? deferInvalidConfig
          : createReviewer({ ...runtime, config, circuitBreaker, sessionSignal: controller.signal }),
      dispose: undefined,
    }
  }

  // Resolved per use rather than cached, so registration survives `/reload` and
  // load-order edge cases (ADR 0012).
  function resolveService(): PermissionsService | undefined {
    return sessionId === undefined ? undefined : getPermissionsService(sessionId)
  }

  function tryRegister(): void {
    // `permissions:ready` fires at least once per session and may repeat, so the
    // stored dispose handle is what keeps a second emission a no-op instead of
    // hitting `registerAuthorizer`'s duplicate-name throw.
    if (generation === undefined || generation.dispose !== undefined) {
      return
    }
    const service = resolveService()
    if (service === undefined) {
      return
    }

    try {
      generation.dispose = service.registerAuthorizer(AUTHORIZER_NAME, generation.authorize)
    } catch (error) {
      warn(`failed to register ${AUTHORIZER_NAME}: ${describeError(error)}`)
    }
  }

  function reportIssues(result: LoadConfigResult): void {
    for (const issue of result.issues) {
      warn(`config issue at ${issue.sourcePath}: ${issue.message}`)
    }
  }

  function applyConfig(result: LoadConfigResult): AutoReviewActivationResult {
    reportIssues(result)
    const current = generation
    const runtime = sessionRuntime
    if (current === undefined || runtime === undefined) {
      return { kind: 'failed', message: 'the Pi session has not started' }
    }
    if (result.config === undefined) {
      return {
        kind: 'failed',
        message: 'the merged config is invalid; the previous reviewer remains active',
      }
    }

    const service = resolveService()
    if (service === undefined && current.dispose !== undefined) {
      // Swapping would strand the registered reviewer: without the service the
      // old link cannot be released, and dropping its handle would leave it
      // deciding under the superseded config for the rest of the session.
      return {
        kind: 'failed',
        message: 'pi-permission-system became unavailable while the old reviewer was still registered',
      }
    }

    const candidate = createGeneration(runtime, result.config)
    current.dispose?.()
    generation = candidate
    current.controller.abort()
    circuitBreaker.resetTurn()

    if (service === undefined) {
      return { kind: 'pending' }
    }

    try {
      candidate.dispose = service.registerAuthorizer(AUTHORIZER_NAME, candidate.authorize)
    } catch (error) {
      // Nothing is registered now, so asks fall through to the human authorizer
      // and the next `permissions:ready` retries this generation.
      return {
        kind: 'failed',
        message: `the new reviewer could not be registered: ${describeError(error)}`,
      }
    }

    return { kind: 'active' }
  }

  pi.on('session_start', (_event, context) => {
    generation?.dispose?.()
    generation?.controller.abort()
    circuitBreaker.resetTurn()

    const result = configStore.load(context.cwd)
    sessionRuntime = {
      registry: context.modelRegistry,
      sessionManager: context.sessionManager,
    }
    generation = createGeneration(sessionRuntime, result.config)
    reportIssues(result)
  })

  // The whole registration. `permissions:ready` is re-emitted at the node's
  // first `before_agent_start`, which runs after every extension's
  // `session_start` and before any ask, so this handler is sufficient on its own
  // regardless of load order — a second attempt from `session_start` is not.
  pi.events.on(PERMISSIONS_READY_CHANNEL, (data: unknown) => {
    const ready = data as PermissionsReadyEvent | undefined
    const readySessionId = ready?.sessionId
    if (readySessionId == null) {
      if (!warnedMissingSessionId) {
        warnedMissingSessionId = true
        warn(`pi-permission-system published no keyed service for this node; ${AUTHORIZER_NAME} stays unregistered`)
      }
      return
    }
    // Our own node's id, which does not change for the life of the session —
    // `session_shutdown` is what clears it. Ready repeats, so this is a
    // learn-once rather than a last-writer-wins assignment.
    sessionId ??= readySessionId
    tryRegister()
  })

  pi.on('turn_start', () => {
    circuitBreaker.resetTurn()
  })

  pi.on('session_shutdown', () => {
    generation?.dispose?.()
    generation?.controller.abort()
    generation = undefined
    sessionRuntime = undefined
    sessionId = undefined
    warnedMissingSessionId = false
    circuitBreaker.resetTurn()
  })

  registerAutoReviewCommand(pi, {
    configStore,
    getActiveConfig: () => generation?.config,
    applyConfig,
  })
}
