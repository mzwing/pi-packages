import { describe, expect, it, vi } from 'vitest'
import { listenForMail, readQueue, removeMail, sendMail, stopListening } from '../src/mailbox.js'
import { useAgentDir } from './helpers.js'

function outgoing(body: string, to = 'bob') {
  return { from: 'alice', fromName: undefined, to, body, wake: true }
}

describe('mailbox', () => {
  useAgentDir()

  it('queues mail for a recipient that is not listening', async () => {
    const { mail, woke } = await sendMail(outgoing('first'))

    expect(woke).toBe(false)
    expect(readQueue('bob')).toEqual([mail])
    expect(readQueue('alice')).toEqual([])
  })

  it('wakes a listening recipient', async () => {
    const onMail = vi.fn()
    const server = await listenForMail('bob', onMail)

    const { woke } = await sendMail(outgoing('ping'))

    expect(woke).toBe(true)
    await vi.waitFor(() => expect(onMail).toHaveBeenCalledOnce())
    stopListening(server, 'bob')
    expect((await sendMail(outgoing('later'))).woke).toBe(false)
  })

  it('keeps the queue in sending order and drops removed mail', async () => {
    const first = (await sendMail(outgoing('first'))).mail
    vi.useFakeTimers({ now: first.sentAt + 1, toFake: ['Date'] })
    const second = (await sendMail(outgoing('second'))).mail
    vi.useRealTimers()

    expect(readQueue('bob').map(mail => mail.body)).toEqual(['first', 'second'])
    removeMail(first)
    expect(readQueue('bob')).toEqual([second])
  })
})
