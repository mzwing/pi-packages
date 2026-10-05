import type { ExtensionAPI, ModelRegistry, RegisteredCommand } from '@earendil-works/pi-coding-agent'
import type {
  Authorizer,
  AuthorizerLog,
  PermissionQuery,
  PermissionsReadyEvent,
  PermissionsService,
} from '@gotgenes/pi-permission-system'
import { existsSync } from 'node:fs'
import {
  PERMISSIONS_READY_CHANNEL,
  publishPermissionsService,
  unpublishPermissionsService,
} from '@gotgenes/pi-permission-system'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configPath } from '../src/config-store.js'
import { EXTENSION_ID } from '../src/config.js'
import permissionAutoReview from '../src/index.js'
import { permissionDetails, useWorkspace, writeFile } from './helpers.js'

type Handler = (...arguments_: unknown[]) => unknown
type Authorize = Authorizer['authorize']

const SESSION_ID = 'session-root'
const DENY = '{"outcome":"deny","rationale":"Not authorized."}'

describe('permission auto-review extension', () => {
  const workspace = useWorkspace()
  const published: [string, PermissionsService][] = []

  afterEach(() => {
    for (const [sessionId, service] of published.splice(0)) {
      unpublishPermissionsService(sessionId, service)
    }
  })

  function publish(registerAuthorizer: PermissionsService['registerAuthorizer'], sessionId = SESSION_ID) {
    const service = { registerAuthorizer } as PermissionsService
    publishPermissionsService(sessionId, service)
    published.push([sessionId, service])
  }

  /** A registry whose every model answers `reply`, so a reviewer's decisions are observable. */
  function reviewRegistry(reply: string) {
    const streamSimple = vi.fn(() => ({
      result: async () => ({
        role: 'assistant',
        content: [{ type: 'text', text: reply }],
        stopReason: 'stop',
        usage: { input: 0, output: 0, cacheRead: 0 },
      }),
    }))
    const registry = {
      getProvider: (id: string) => ({ id, getModels: () => [] }),
      find: (provider: string, id: string) => ({
        id,
        provider,
        api: 'openai-responses',
        reasoning: false,
        contextWindow: 200_000,
      }),
      getAll: () => [],
      streamSimple,
    } as unknown as ModelRegistry

    return { registry, streamSimple }
  }

  function start(registry: ModelRegistry = reviewRegistry(DENY).registry, projectTrusted = true) {
    const handlers = new Map<string, Handler[]>()
    const eventHandlers = new Map<string, Handler[]>()
    let command: Omit<RegisteredCommand, 'name' | 'sourceInfo'> | undefined
    const add = (target: Map<string, Handler[]>, name: string, handler: Handler): void => {
      target.set(name, [...(target.get(name) ?? []), handler])
    }
    const pi = {
      on: (name: string, handler: Handler) => add(handlers, name, handler),
      events: { on: (name: string, handler: Handler) => add(eventHandlers, name, handler) },
      registerCommand: (_name: string, options: typeof command) => {
        command = options
      },
    }
    permissionAutoReview(pi as unknown as ExtensionAPI)

    const emit = (name: string, ...arguments_: unknown[]): void => {
      for (const handler of handlers.get(name) ?? []) {
        handler(...arguments_)
      }
    }
    const setStatus = vi.fn()
    const context = {
      cwd: workspace.cwd,
      modelRegistry: registry,
      sessionManager: { getBranch: () => [], getSessionId: () => SESSION_ID },
      ui: { setStatus },
      isProjectTrusted: () => projectTrusted,
    }
    const notify = vi.fn()

    return {
      emit,
      start: () => emit('session_start', {}, context),
      shutdown: () => emit('session_shutdown', {}, context),
      setStatus,
      ready(sessionId: string | null = SESSION_ID) {
        for (const handler of eventHandlers.get(PERMISSIONS_READY_CHANNEL) ?? []) {
          handler({ sessionId, adjudicatesLocally: true } satisfies PermissionsReadyEvent)
        }
      },
      notify,
      async run(args: string) {
        await command?.handler(args, {
          ...context,
          mode: 'tui',
          hasUI: true,
          ui: { confirm: async () => true, notify },
          waitForIdle: async () => {},
        } as never)
      },
    }
  }

  async function review(authorize: Authorize | undefined) {
    const reviewLog = vi.fn<AuthorizerLog['review']>()
    const verdict = await authorize?.(permissionDetails(), {} as PermissionQuery, { review: reviewLog, debug: vi.fn() })

    return { verdict, entry: reviewLog.mock.calls[0] }
  }

  it('registers once even though permissions:ready repeats', () => {
    const dispose = vi.fn()
    const registerAuthorizer = vi.fn(() => dispose)
    publish(registerAuthorizer)
    const harness = start()

    harness.start()
    expect(registerAuthorizer).not.toHaveBeenCalled()

    // Ready fires at session_start and again at the first before_agent_start.
    harness.ready()
    harness.ready()
    expect(registerAuthorizer).toHaveBeenCalledExactlyOnceWith('auto-review', expect.any(Function))

    harness.shutdown()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('registers on the repeat emission when ready precedes session_start', () => {
    const registerAuthorizer = vi.fn(() => vi.fn())
    publish(registerAuthorizer)
    const harness = start()

    harness.ready()
    harness.start()
    expect(registerAuthorizer).not.toHaveBeenCalled()

    harness.ready()
    expect(registerAuthorizer).toHaveBeenCalledOnce()
  })

  it('registers each node into the service keyed by its own session id', () => {
    const rootDispose = vi.fn()
    const childDispose = vi.fn()
    const rootRegister = vi.fn(() => rootDispose)
    const childRegister = vi.fn(() => childDispose)
    publish(rootRegister)
    publish(childRegister, 'session-subagent')
    const root = start()
    const child = start()
    root.start()
    child.start()

    root.ready()
    child.ready('session-subagent')
    expect(rootRegister).toHaveBeenCalledOnce()
    expect(childRegister).toHaveBeenCalledOnce()

    // Each instance holds its own handle, so a shutdown never disposes another node's registration.
    child.shutdown()
    expect(childDispose).toHaveBeenCalledOnce()
    expect(rootDispose).not.toHaveBeenCalled()
  })

  it('warns once and stays unregistered when the node published no keyed service', () => {
    const registerAuthorizer = vi.fn(() => vi.fn())
    publish(registerAuthorizer)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const harness = start()

    harness.start()
    harness.ready(null)
    harness.ready(null)

    expect(registerAuthorizer).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('published no keyed service'))
    warn.mockRestore()
  })

  it('registers a defer-only reviewer when config is invalid', async () => {
    writeFile(configPath(workspace.cwd, 'global'), { apiKey: 'not-allowed' })
    const registerAuthorizer = vi.fn((_name: string, _authorize: Authorize) => vi.fn())
    publish(registerAuthorizer)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const harness = start()

    harness.start()
    harness.ready()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('config issue at'))
    warn.mockRestore()

    const { verdict, entry } = await review(registerAuthorizer.mock.calls[0]?.[1])
    expect(verdict).toEqual({ kind: 'defer' })
    expect(entry).toEqual(['auto_review.decision', expect.objectContaining({ errorCategory: 'config-invalid' })])
    expect(harness.setStatus).toHaveBeenLastCalledWith(EXTENSION_ID, 'auto-review inactive: invalid config')
  })

  it('ignores the config of a project Pi does not trust, and warns that it does', async () => {
    writeFile(configPath(workspace.cwd, 'project'), { model: 'project-model' })
    const registerAuthorizer = vi.fn((_name: string, _authorize: Authorize) => vi.fn())
    publish(registerAuthorizer)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const harness = start(reviewRegistry(DENY).registry, false)

    harness.start()
    harness.ready()
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('is ignored until Pi trusts this project'))
    warn.mockRestore()

    expect((await review(registerAuthorizer.mock.calls[0]?.[1])).entry?.[1]).toMatchObject({
      model: 'codex-auto-review',
    })
  })

  it('shows in the footer whether the reviewer is registered and how it has decided', async () => {
    const registerAuthorizer = vi.fn((_name: string, _authorize: Authorize) => vi.fn())
    publish(registerAuthorizer)
    const harness = start()

    harness.start()
    expect(harness.setStatus).toHaveBeenLastCalledWith(EXTENSION_ID, 'auto-review inactive')
    harness.ready()
    expect(harness.setStatus).toHaveBeenLastCalledWith(EXTENSION_ID, 'auto-review ready')

    await review(registerAuthorizer.mock.calls[0]?.[1])
    expect(harness.setStatus).toHaveBeenLastCalledWith(EXTENSION_ID, 'auto-review ready · 1 denied')

    harness.shutdown()
    expect(harness.setStatus).toHaveBeenLastCalledWith(EXTENSION_ID, undefined)
  })

  it('hot-swaps the reviewer generation after a config reset, closing the circuit', async () => {
    const global = configPath(workspace.cwd, 'global')
    writeFile(global, { model: 'old-review-model' })
    const firstDispose = vi.fn()
    const secondDispose = vi.fn()
    const registerAuthorizer = vi
      .fn<(name: string, authorize: Authorize) => () => void>()
      .mockReturnValueOnce(firstDispose)
      .mockReturnValueOnce(secondDispose)
    publish(registerAuthorizer)
    const { registry, streamSimple } = reviewRegistry(DENY)
    const harness = start(registry)
    harness.start()
    harness.ready()

    const first = registerAuthorizer.mock.calls[0]?.[1]
    for (let denial = 0; denial < 3; denial += 1) {
      expect((await review(first)).entry?.[1]).toMatchObject({ model: 'old-review-model', outcome: 'deny' })
    }
    expect((await review(first)).entry?.[0]).toBe('auto_review.circuit_open')
    expect(streamSimple).toHaveBeenCalledTimes(3)

    await harness.run('reset global')

    expect(existsSync(global)).toBe(false)
    expect(firstDispose).toHaveBeenCalledOnce()
    const second = registerAuthorizer.mock.calls[1]?.[1]
    expect((await review(second)).entry?.[1]).toMatchObject({ model: 'codex-auto-review', outcome: 'deny' })
    expect(streamSimple).toHaveBeenCalledTimes(4)

    harness.shutdown()
    expect(secondDispose).toHaveBeenCalledOnce()
  })

  it('preserves the old reviewer when reset leaves the merged config invalid', async () => {
    const global = configPath(workspace.cwd, 'global')
    const project = configPath(workspace.cwd, 'project')
    writeFile(global, { reasoning: 'high' })
    writeFile(project, { includeBaselinePolicy: false, additionalPolicy: 'Review conservatively.' })
    const firstDispose = vi.fn()
    const registerAuthorizer = vi.fn(() => firstDispose)
    publish(registerAuthorizer)
    const harness = start()
    harness.start()
    harness.ready()
    writeFile(project, { includeBaselinePolicy: false })

    await harness.run('reset global')

    expect(existsSync(global)).toBe(false)
    expect(firstDispose).not.toHaveBeenCalled()
    expect(registerAuthorizer).toHaveBeenCalledOnce()
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringContaining('the merged config is invalid; the previous reviewer remains active'),
      'error',
    )
  })

  it('reports a failed swap and retries the new generation at the next ready', async () => {
    writeFile(configPath(workspace.cwd, 'global'), { reasoning: 'high' })
    const firstDispose = vi.fn()
    const secondDispose = vi.fn()
    const registerAuthorizer = vi
      .fn<(name: string, authorize: Authorize) => () => void>()
      .mockReturnValueOnce(firstDispose)
      .mockImplementationOnce(() => {
        throw new Error('candidate rejected')
      })
      .mockReturnValueOnce(secondDispose)
    publish(registerAuthorizer)
    const harness = start()
    harness.start()
    harness.ready()

    await harness.run('reset global')

    // The old link is released before the new one is offered, so a rejected registration leaves no link at
    // all rather than a reviewer running the superseded config.
    expect(firstDispose).toHaveBeenCalledOnce()
    expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining('could not be registered'), 'error')

    harness.ready()
    const [first, rejected, retried] = registerAuthorizer.mock.calls.map(([, authorize]) => authorize)
    expect(retried).toBe(rejected)
    expect(retried).not.toBe(first)

    harness.shutdown()
    expect(secondDispose).toHaveBeenCalledOnce()
  })

  it('keeps a saved generation pending until permission-system becomes ready', async () => {
    writeFile(configPath(workspace.cwd, 'global'), { model: 'old-review-model' })
    const registerAuthorizer = vi.fn((_name: string, _authorize: Authorize) => vi.fn())
    const harness = start()
    harness.start()

    await harness.run('reset global')
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringContaining('will activate when pi-permission-system is ready'),
      'warning',
    )

    publish(registerAuthorizer)
    harness.ready()
    expect(registerAuthorizer).toHaveBeenCalledOnce()
    expect((await review(registerAuthorizer.mock.calls[0]?.[1])).entry?.[1]).toMatchObject({
      model: 'codex-auto-review',
    })
  })
})
