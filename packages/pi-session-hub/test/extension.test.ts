import type { Mail } from '../src/mail/mailbox.js'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MAIL_EVENT, readQueue, sendMail } from '../src/mail/mailbox.js'
import { findLiveSession } from '../src/sessions/registry.js'
import { loadHub, sessionContext, useAgentDir } from './helpers.js'

function outgoing(body: string, wake = true) {
  return { from: 'boss', fromName: 'Boss', to: 'worker', body, wake }
}

/** The entry a session holds once Pi has written the mail. */
function written(mail: Mail): SessionEntry {
  return {
    type: 'custom_message',
    id: mail.id,
    parentId: null,
    timestamp: '',
    customType: 'session-hub:message',
    content: mail.body,
    display: true,
    details: { mailId: mail.id, from: mail.from },
  }
}

describe('session hub extension', () => {
  const agent = useAgentDir()

  /** Queues mail the way another process does, without waking the recipient. */
  function queueSilently(mail: Mail): void {
    const directory = join(agent.root, 'pi-session-hub', 'mail', mail.to)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, `${mail.sentAt}-${mail.id}.json`), JSON.stringify(mail))
  }

  it('registers a started session and removes it at shutdown', async () => {
    const hub = loadHub()
    const tui = sessionContext({ id: 'worker' })
    await hub.emit('session_start', { reason: 'startup' }, tui)

    expect(findLiveSession('worker')).toMatchObject({ id: 'worker', cwd: '/project', file: '/sessions/worker.jsonl' })

    await hub.emit('session_shutdown', { reason: 'quit' }, tui)
    expect(findLiveSession('worker')).toBeUndefined()
  })

  it('hands mail arriving during a session to Pi, steering when it should wake and recording it otherwise', async () => {
    const hub = loadHub()
    const tui = sessionContext({ id: 'worker' })
    await hub.emit('session_start', {}, tui)

    await sendMail(outgoing('urgent'))
    await sendMail(outgoing('fyi', false))

    await vi.waitFor(() => expect(hub.sent).toHaveLength(2))
    expect(hub.sent.map(sent => sent.options)).toEqual([
      { triggerTurn: true, deliverAs: 'steer' },
      { triggerTurn: false },
    ])
    expect(hub.sent[0]?.message).toMatchObject({ customType: 'session-hub:message', display: true })
    expect(hub.sent[0]?.message['content']).toContain('"Boss" (boss)')
    expect(hub.sent[0]?.message['content']).toContain('urgent')
    expect(hub.events.map(event => event.channel)).toEqual([MAIL_EVENT, MAIL_EVENT])
    await hub.emit('session_shutdown', {}, tui)
  })

  it('drops mail from the queue only once the session holds it', async () => {
    const hub = loadHub()
    await hub.emit('session_start', {}, sessionContext({ id: 'worker' }))
    const urgent = (await sendMail(outgoing('urgent'))).mail
    await sendMail(outgoing('fyi', false))
    await vi.waitFor(() => expect(hub.sent).toHaveLength(2))
    const holding = sessionContext({ id: 'worker', entries: [written(urgent)] })

    await hub.emit('agent_settled', { aborted: false }, holding)
    expect(readQueue('worker').map(mail => mail.body)).toEqual(['fyi'])
    // Quitting before Pi writes the rest keeps it queued for the next start.
    await hub.emit('session_shutdown', {}, holding)
    expect(readQueue('worker').map(mail => mail.body)).toEqual(['fyi'])
  })

  it('records queued mail at start and drops mail the session already holds', async () => {
    const held = (await sendMail(outgoing('old'))).mail
    await sendMail(outgoing('new'))

    const hub = loadHub()
    const tui = sessionContext({ id: 'worker', entries: [written(held)] })
    await hub.emit('session_start', {}, tui)

    expect(hub.sent.map(sent => sent.options)).toEqual([{ triggerTurn: false }])
    expect(hub.sent[0]?.message['content']).toContain('new')
    expect(readQueue('worker').map(mail => mail.body)).toEqual(['new'])
    await hub.emit('session_shutdown', {}, tui)
  })

  it('records steered mail again once the user stops a run in the TUI, which drops it from Pi', async () => {
    const hub = loadHub()
    const tui = sessionContext({ id: 'worker' })
    await hub.emit('session_start', {}, tui)
    await sendMail(outgoing('urgent'))
    await vi.waitFor(() => expect(hub.sent).toHaveLength(1))

    await hub.emit('agent_settled', { aborted: false }, tui)
    expect(hub.sent).toHaveLength(1)
    await hub.emit('agent_settled', { aborted: true }, tui)

    expect(hub.sent.map(sent => sent.options)).toEqual([
      { triggerTurn: true, deliverAs: 'steer' },
      { triggerTurn: false },
    ])
    await hub.emit('session_shutdown', {}, tui)
  })

  it('hands mail that came too late to steer a print run over as entries before it settles', async () => {
    const hub = loadHub()
    const print = sessionContext({ id: 'worker', mode: 'print' })
    await hub.emit('session_start', {}, print)
    const late = { ...outgoing('late'), id: 'late-1', sentAt: 1 }
    queueSilently(late)

    expect(await hub.emit('agent_before_settle', { outcome: 'error' }, print)).toEqual([undefined])
    const [result] = await hub.emit('agent_before_settle', { outcome: 'completed' }, print)

    expect(result).toMatchObject({
      continue: true,
      entries: [{ type: 'custom_message', customType: 'session-hub:message', details: { mailId: 'late-1' } }],
    })
    expect(await hub.emit('agent_before_settle', { outcome: 'completed' }, print)).toEqual([undefined])
    await hub.emit(
      'agent_settled',
      { aborted: false },
      sessionContext({ id: 'worker', mode: 'print', entries: [written(late)] }),
    )
    expect(readQueue('worker')).toEqual([])
    await hub.emit('session_shutdown', {}, print)
  })

  it('leaves late mail queued in an interactive session, whose wake-up delivers it', async () => {
    const hub = loadHub()
    const tui = sessionContext({ id: 'worker' })
    await hub.emit('session_start', {}, tui)
    queueSilently({ ...outgoing('late'), id: 'late-1', sentAt: 1 })

    expect(await hub.emit('agent_before_settle', { outcome: 'completed' }, tui)).toEqual([undefined])
    expect(readQueue('worker')).toHaveLength(1)
    await hub.emit('session_shutdown', {}, tui)
  })
})
