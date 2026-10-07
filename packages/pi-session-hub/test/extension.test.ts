import type { Mail } from '../src/mailbox.js'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MAIL_EVENT, readQueue, sendMail } from '../src/mailbox.js'
import { findLiveSession } from '../src/registry.js'
import { loadHub, sessionContext, useAgentDir } from './helpers.js'

function outgoing(body: string, wake = true) {
  return { from: 'boss', fromName: 'Boss', to: 'worker', body, wake }
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
    await hub.emit('session_start', { reason: 'startup' }, sessionContext({ id: 'worker' }))

    expect(findLiveSession('worker')).toMatchObject({ id: 'worker', cwd: '/project', file: '/sessions/worker.jsonl' })

    await hub.emit('session_shutdown', { reason: 'quit' })
    expect(findLiveSession('worker')).toBeUndefined()
  })

  it('hands mail arriving during a session to Pi, steering when it should wake', async () => {
    const hub = loadHub()
    await hub.emit('session_start', {}, sessionContext({ id: 'worker' }))

    await sendMail(outgoing('urgent'))
    await sendMail(outgoing('fyi', false))

    await vi.waitFor(() => expect(hub.sent).toHaveLength(2))
    expect(hub.sent.map(sent => sent.options)).toEqual([
      { triggerTurn: true, deliverAs: 'steer' },
      { deliverAs: 'nextTurn' },
    ])
    expect(hub.sent[0]?.message).toMatchObject({ customType: 'session-hub:message', display: true })
    expect(hub.sent[0]?.message['content']).toContain('"Boss" (boss)')
    expect(hub.sent[0]?.message['content']).toContain('urgent')
    expect(hub.events.map(event => event.channel)).toEqual([MAIL_EVENT, MAIL_EVENT])
    await hub.emit('session_shutdown', {})
  })

  it('drops mail from the queue once the session has written it', async () => {
    const hub = loadHub()
    await hub.emit('session_start', {}, sessionContext({ id: 'worker' }))
    await sendMail(outgoing('note'))
    await vi.waitFor(() => expect(hub.sent).toHaveLength(1))
    expect(readQueue('worker')).toHaveLength(1)

    await hub.emit('message_end', { message: { role: 'custom', ...hub.sent[0]?.message } })

    expect(readQueue('worker')).toEqual([])
    await hub.emit('session_shutdown', {})
  })

  it('joins queued mail to the first turn and drops mail the session already holds', async () => {
    const held = (await sendMail(outgoing('old'))).mail
    await sendMail(outgoing('new'))
    const entries = [
      {
        type: 'custom_message',
        id: 'e1',
        parentId: null,
        timestamp: '',
        customType: 'session-hub:message',
        content: 'old',
        display: true,
        details: { mailId: held.id, from: 'boss' },
      },
    ] as SessionEntry[]

    const hub = loadHub()
    await hub.emit('session_start', {}, sessionContext({ id: 'worker', entries }))

    expect(hub.sent.map(sent => sent.options)).toEqual([{ deliverAs: 'nextTurn' }])
    expect(hub.sent[0]?.message['content']).toContain('new')
    expect(readQueue('worker').map(mail => mail.body)).toEqual(['new'])
    await hub.emit('session_shutdown', {})
  })

  it('hands mail that came too late to steer a print run over as entries before it settles', async () => {
    const hub = loadHub()
    const print = sessionContext({ id: 'worker', mode: 'print' })
    await hub.emit('session_start', {}, print)
    queueSilently({ ...outgoing('late'), id: 'late-1', sentAt: 1 })

    expect(await hub.emit('agent_before_settle', { outcome: 'error' }, print)).toEqual([undefined])
    const [result] = await hub.emit('agent_before_settle', { outcome: 'completed' }, print)

    expect(result).toMatchObject({
      continue: true,
      entries: [{ type: 'custom_message', customType: 'session-hub:message', details: { mailId: 'late-1' } }],
    })
    expect(readQueue('worker')).toEqual([])
    await hub.emit('session_shutdown', {})
  })

  it('leaves late mail queued in an interactive session, whose wake-up delivers it', async () => {
    const hub = loadHub()
    const tui = sessionContext({ id: 'worker' })
    await hub.emit('session_start', {}, tui)
    queueSilently({ ...outgoing('late'), id: 'late-1', sentAt: 1 })

    expect(await hub.emit('agent_before_settle', { outcome: 'completed' }, tui)).toEqual([undefined])
    expect(readQueue('worker')).toHaveLength(1)
    await hub.emit('session_shutdown', {})
  })
})
