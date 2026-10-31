import type { Mail } from './mail/mailbox.js'
import type { SessionRecord } from './sessions/registry.js'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { Server } from 'node:net'
import process from 'node:process'
import { listenForMail, MAIL_EVENT, readQueue, removeMail, stopListening } from './mail/mailbox.js'
import { registerSession, unregisterSession } from './sessions/registry.js'
import { DEFAULT_TRANSCRIPT, describeSessions, describeTranscript, registerSessionTools } from './sessions/tools.js'

const MESSAGE_TYPE = 'session-hub:message'

interface MailDetails {
  mailId: string
  from: string
}

interface MailMessage {
  customType: string
  content: string
  display: boolean
  details: MailDetails
}

function toMessage(mail: Mail): MailMessage {
  const sender = mail.fromName === undefined ? mail.from : `"${mail.fromName}" (${mail.from})`

  return {
    customType: MESSAGE_TYPE,
    content: `Message from session ${sender}; reply with session_send if it needs an answer.\n\n${mail.body}`,
    display: true,
    details: { mailId: mail.id, from: mail.from },
  }
}

export default function sessionHub(pi: ExtensionAPI): void {
  let current: { record: SessionRecord; server: Server | undefined } | undefined
  // Ids of mail handed to Pi whose queue files are still there
  const pending = new Set<string>()

  function deliver(sessionId: string, startTurns: boolean): void {
    for (const mail of readQueue(sessionId)) {
      if (pending.has(mail.id)) {
        continue
      }
      pending.add(mail.id)
      pi.sendMessage(
        toMessage(mail),
        startTurns && mail.wake ? { triggerTurn: true, deliverAs: 'steer' } : { triggerTurn: false },
      )
      pi.events.emit(MAIL_EVENT, mail)
    }
  }

  // A queue file goes only once the session holds its mail: Pi sends extensions no message_end for mail written without a turn, and quitting mid-turn drops what it has not written yet
  function confirm(ctx: ExtensionContext): void {
    const queued = readQueue(ctx.sessionManager.getSessionId())
    if (queued.length === 0) {
      return
    }
    const written = new Set(
      ctx.sessionManager
        .getEntries()
        .flatMap(entry =>
          entry.type === 'custom_message' && entry.customType === MESSAGE_TYPE
            ? [(entry.details as MailDetails).mailId]
            : [],
        ),
    )
    for (const mail of queued) {
      if (written.has(mail.id)) {
        removeMail(mail)
        pending.delete(mail.id)
      }
    }
  }

  function stopDelivery(): void {
    if (current?.server !== undefined) {
      stopListening(current.server, current.record.id)
      current.server = undefined
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    const record: SessionRecord = {
      id: ctx.sessionManager.getSessionId(),
      file: ctx.sessionManager.getSessionFile(),
      cwd: ctx.cwd,
      name: ctx.sessionManager.getSessionName(),
      pid: process.pid,
    }
    registerSession(record)
    confirm(ctx)
    current = { record, server: await listenForMail(record.id, () => deliver(record.id, true)) }
    // A session that is only starting has no turn to steer, so queued mail joins its first one
    deliver(record.id, false)
  })

  pi.on('session_info_changed', event => {
    if (current !== undefined) {
      current.record = { ...current.record, name: event.name }
      registerSession(current.record)
    }
  })

  // Print mode exits once settled, so mail that arrived too late to steer the run is handed over here
  pi.on('agent_before_settle', (event, ctx) => {
    if (ctx.mode !== 'print' || event.outcome !== 'completed' || current === undefined) {
      return
    }
    const late = readQueue(current.record.id).filter(mail => !pending.has(mail.id))
    if (late.length === 0) {
      return
    }
    for (const mail of late) {
      pending.add(mail.id)
    }

    return {
      entries: late.map(mail => ({ type: 'custom_message' as const, ...toMessage(mail) })),
      continue: late.some(mail => mail.wake),
    }
  })

  pi.on('agent_settled', (event, ctx) => {
    confirm(ctx)
    if (ctx.mode === 'print') {
      stopDelivery()
    } else if (event.aborted && ctx.mode === 'tui') {
      // Stopping a run in the TUI empties Pi's steering queue, dropping mail the run had not reached
      pending.clear()
      deliver(ctx.sessionManager.getSessionId(), false)
    }
  })

  pi.on('session_shutdown', (_event, ctx) => {
    confirm(ctx)
    stopDelivery()
    if (current !== undefined) {
      unregisterSession(current.record.id)
      current = undefined
    }
    pending.clear()
  })

  registerSessionTools(pi)

  pi.registerCommand('sessions', {
    description: 'List running sessions, or show the transcript of the session whose id follows',
    handler: async (args, ctx) => {
      const id = args.trim()
      if (id === '') {
        ctx.ui.notify(await describeSessions(ctx), 'info')

        return
      }
      ctx.ui.notify(
        (await describeTranscript(id, ctx.cwd, DEFAULT_TRANSCRIPT)) ?? `No session has the id ${id}.`,
        'info',
      )
    },
  })
}
