import type { Runtime } from './sessions/runtime.js'
import type { State } from './tasks/task.js'
import type {
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from '@earendil-works/pi-coding-agent'
import { dirname } from 'node:path'
import process from 'node:process'
import { MAIL_EVENT } from '@mzwing/pi-session-hub/api'
import { EXTENSION_ID } from './config.js'
import { activateCoordinatorTools, coordinate, registerCoordinatorTools, renderBoard } from './roles/coordinator.js'
import { registerDeclareTools } from './roles/declare.js'
import { announceExit, registerExecutor } from './roles/executor.js'
import { handoffMessage, roleSection } from './roles/prompts.js'
import { registerReviewerTools } from './roles/reviewer.js'
import { registerWorkTools } from './roles/work.js'
import { childBinding } from './sessions/children.js'
import { governBash, registerGuard, writeShims } from './sessions/guard.js'
import { requireRole, resumesLease } from './sessions/runtime.js'
import { createScheduler, executorStatus, STORE_FLAG } from './tasks/scheduler.js'
import { findRepoRoot, readState, storeDirectory, storeExists, updateState } from './tasks/store.js'
import { claimedRoot, isOpen, waitsFor } from './tasks/task.js'
import { describeError } from './tooling.js'
import { loadEnvironment } from './workspace/env.js'

const SUBCOMMANDS = ['coordinate', 'pause', 'resume', 'unlock', 'handoff']
const DEFAULT_UNLOCK_MINUTES = 30
const WORDS = /\s+/

function statusText(state: State): string {
  const roots = Object.values(state.tasks).filter(task => task.parentId === undefined)
  const statuses = roots.flatMap(task =>
    task.claim === undefined || !isOpen(task) ? [] : [executorStatus(task.claim)],
  )
  const count = (status: string): number => statuses.filter(current => current === status).length
  const declared = roots.filter(task => task.state === 'declared')
  const waiting = declared.filter(task => waitsFor(state, task).length > 0).length
  const part = (amount: number, label: string): string[] => (amount > 0 ? [`${amount} ${label}`] : [])

  return [
    `governor ${count('preparing') + count('running')}/${state.config.maxExecutors}`,
    ...part(declared.length - waiting, 'queued'),
    ...part(waiting, 'waiting'),
    ...part(count('asking'), 'asking'),
    ...part(count('stalled'), 'stalled'),
    ...part(roots.filter(task => task.state === 'approving' && task.approval === undefined).length, 'to sign off'),
    ...(state.paused ? ['paused'] : []),
  ].join(' · ')
}

/**
 * Undefined outside a governed repository. An executor is started with the store's path and holds its role only if
 * the store names its pid; a coordinator resumed in the TUI takes its lease back.
 */
function resolveRuntime(ctx: ExtensionContext, storeFlag: string | undefined): Runtime | undefined {
  const sessionId = ctx.sessionManager.getSessionId()
  // Developers and reviewers run inside their executor's process, which started with the store flag too.
  const child = childBinding(sessionId)
  if (child !== undefined) {
    const { store, role, environment } = child

    return { store, repoRoot: dirname(dirname(store)), sessionId, role, environment }
  }
  if (storeFlag !== undefined) {
    const root = updateState(storeFlag, state => claimedRoot(state, sessionId))
    const bound = root?.claim?.pid === process.pid

    return {
      store: storeFlag,
      repoRoot: dirname(dirname(storeFlag)),
      sessionId,
      role: bound ? 'executor' : undefined,
      environment: bound ? loadEnvironment(storeFlag, root.id).changes : {},
    }
  }
  const repoRoot = findRepoRoot(ctx.cwd)
  if (repoRoot === undefined || !storeExists(storeDirectory(repoRoot))) {
    return undefined
  }
  const store = storeDirectory(repoRoot)
  const coordinates =
    ctx.mode === 'tui' &&
    updateState(store, state => {
      if (!resumesLease(state, sessionId)) {
        return false
      }
      state.lease = { sessionId, pid: process.pid }

      return true
    })

  return { store, repoRoot, sessionId, role: coordinates ? 'coordinator' : undefined, environment: {} }
}

export default function taskGovernor(pi: ExtensionAPI): void {
  let runtime: Runtime | undefined
  let ui: ExtensionUIContext | undefined

  function refreshStatus(): void {
    ui?.setStatus(EXTENSION_ID, runtime?.role === 'coordinator' ? statusText(readState(runtime.store)) : undefined)
  }

  const scheduler = createScheduler(
    {
      runtime: () => runtime,
      changed: refreshStatus,
    },
    (message, wake) =>
      pi.sendMessage(
        { customType: 'pi-task-governor:event', content: message, display: true },
        wake ? { triggerTurn: true, deliverAs: 'followUp' } : { triggerTurn: false },
      ),
  )
  const host = {
    runtime: () => runtime,
    changed: () => {
      refreshStatus()
      scheduler.tick()
    },
  }

  function govern(ctx: ExtensionContext, governed: Runtime): void {
    runtime = governed
    writeShims(governed.store)
    governBash(pi, ctx, host.runtime)
  }

  pi.registerFlag(STORE_FLAG, { description: 'Store of the task an executor session works on', type: 'string' })

  pi.on('session_start', (_event, ctx) => {
    ui = ctx.ui
    const flag = pi.getFlag(STORE_FLAG)
    const resolved = resolveRuntime(ctx, typeof flag === 'string' ? flag : undefined)
    if (resolved === undefined) {
      return
    }
    govern(ctx, resolved)
    if (resolved.role === 'coordinator') {
      activateCoordinatorTools(pi)
      host.changed()
    }
    if (typeof flag === 'string' && resolved.role === undefined) {
      // Started with a store it holds no task in, such as by hand with an executor's session id: run nothing.
      pi.on('input', () => ({ action: 'handled' }))
    }
  })

  pi.on('before_agent_start', (event): BeforeAgentStartEventResult | undefined => {
    if (runtime?.role === undefined) {
      return undefined
    }
    const options = event.systemPromptOptions
    const section = roleSection(runtime.role, readState(runtime.store).config)
    // Pi renders a prompt another extension forced, such as pi-magic-context's, as is and drops every section.
    if (options.forceSystemPrompt !== undefined) {
      return { systemPrompt: `${event.systemPrompt}\n\n<governor_role>\n${section}\n</governor_role>` }
    }
    options.sections = { ...options.sections, governor_role: section }

    return undefined
  })

  // pi-permission-system forwards an executor process's asks to the session this names, which a handoff replaces.
  pi.on('turn_start', () => {
    if (runtime?.role === undefined || runtime.role === 'coordinator') {
      return
    }
    const { lease } = readState(runtime.store)
    if (lease !== undefined) {
      process.env['PI_SUBAGENT_PARENT_SESSION'] = lease.sessionId
    }
  })

  // Counted in turns, since a context manager such as pi-magic-context may keep Pi from ever compacting.
  let turns = 0
  let reminded = false
  pi.on('turn_end', () => {
    turns += 1
    if (
      runtime?.role === 'coordinator' &&
      !reminded &&
      turns >= readState(runtime.store).config.roles.coordinator.maxTurns
    ) {
      reminded = true
      ui?.notify(
        `This coordinator session has run ${turns} turns; /governor handoff continues in a fresh one seeded from the task board.`,
        'warning',
      )
    }
  })

  pi.events.on(MAIL_EVENT, () => scheduler.tick())

  pi.on('session_shutdown', async () => {
    if (runtime?.role === 'executor') {
      await announceExit(runtime)
    }
    runtime = undefined
    refreshStatus()
    ui = undefined
  })

  registerGuard(pi, host.runtime)
  registerCoordinatorTools(pi, host)
  registerDeclareTools(pi, host)
  registerExecutor(pi, host)
  registerWorkTools(pi, host)
  registerReviewerTools(pi, host)

  pi.registerCommand('governor', {
    description: `Show the task tree, or ${SUBCOMMANDS.join(' | ')}`,
    getArgumentCompletions: prefix =>
      SUBCOMMANDS.filter(subcommand => subcommand.startsWith(prefix.trim())).map(subcommand => ({
        value: subcommand,
        label: subcommand,
      })),
    handler: async (args, ctx) => {
      // Agents can run commands headlessly through `pi -p "/…"`; only the human's TUI may govern.
      if (ctx.mode !== 'tui') {
        return
      }
      const [subcommand = '', argument] = args.trim().split(WORDS)
      try {
        switch (subcommand) {
          case '':
            ctx.ui.notify(
              runtime === undefined
                ? 'This repository is not governed; run /governor coordinate in its main workspace.'
                : renderBoard(readState(runtime.store)),
              'info',
            )
            break
          case 'coordinate':
            govern(ctx, coordinate(pi, ctx))
            ctx.ui.notify('This session now coordinates the repository.', 'info')
            break
          case 'pause':
          case 'resume': {
            const { store } = requireRole(runtime, 'coordinator')
            updateState(store, state => {
              state.paused = subcommand === 'pause'
            })
            break
          }
          case 'unlock': {
            if (runtime === undefined) {
              throw new Error('This repository is not governed.')
            }
            if (runtime.role === 'coordinator') {
              throw new Error('The coordinator runs git, jj and pi unblocked.')
            }
            const { store, sessionId } = runtime
            const minutes = argument === undefined ? DEFAULT_UNLOCK_MINUTES : Number(argument)
            if (!Number.isFinite(minutes) || minutes < 0) {
              throw new Error('Usage: /governor unlock [minutes], where 0 locks again.')
            }
            updateState(store, state => {
              state.unlocks[sessionId] = Date.now() + minutes * 60_000
            })
            ctx.ui.notify(
              minutes === 0
                ? 'git and jj are blocked again in this session.'
                : `git and jj are unlocked in this session for ${minutes} minutes.`,
              'warning',
            )
            break
          }
          case 'handoff': {
            const { store } = requireRole(runtime, 'coordinator')
            const board = renderBoard(
              updateState(store, state => {
                state.lease!.handoff = true

                return state
              }),
            )
            const previous = ctx.sessionManager.getSessionId()
            await ctx.newSession({
              withSession: async next =>
                next.sendMessage(
                  { customType: 'pi-task-governor:handoff', content: handoffMessage(board, previous), display: true },
                  { triggerTurn: false },
                ),
            })

            return
          }
          default:
            ctx.ui.notify(`Usage: /governor [${SUBCOMMANDS.join(' | ')}]`, 'warning')
        }
      } catch (error) {
        ctx.ui.notify(describeError(error), 'error')
      }
      host.changed()
    },
  })
}
