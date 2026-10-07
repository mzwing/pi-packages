import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { listenForMail, readQueue, stopListening } from '../src/mailbox.js'
import { registerSession } from '../src/registry.js'
import { loadHub, sessionContext, useAgentDir } from './helpers.js'

async function run(tool: string, params: Record<string, unknown>, sessionId = 'me') {
  const definition = loadHub().tools.get(tool)!

  return definition.execute('call-1', params, undefined, undefined, sessionContext({ id: sessionId }) as never)
}

function registerRunning(id: string): void {
  registerSession({ id, file: `/sessions/${id}.jsonl`, cwd: '/project', name: 'Peer', pid: process.pid })
}

describe('session tools', () => {
  useAgentDir()

  it('sends to a running session and wakes it', async () => {
    registerRunning('peer')
    const server = await listenForMail('peer', () => {})

    const result = await run('session_send', { to: 'peer', message: 'status?' })

    expect(result.content).toEqual([{ type: 'text', text: 'Delivered to peer "Peer".' }])
    expect(readQueue('peer')).toMatchObject([{ from: 'me', body: 'status?', wake: true }])
    stopListening(server, 'peer')
  })

  it('refuses to message itself or a session that is not running', async () => {
    await expect(run('session_send', { to: 'me', message: 'hi' })).rejects.toThrow('cannot message itself')
    await expect(run('session_send', { to: 'nobody', message: 'hi' })).rejects.toThrow('not running')
    expect(readQueue('nobody')).toEqual([])
  })

  it('refuses a spawn prompt that would run a command or attach a file', async () => {
    await expect(run('session_spawn', { prompt: '/governor unlock' })).rejects.toThrow('reword it')
    await expect(run('session_spawn', { prompt: ' @secrets.txt' })).rejects.toThrow('reword it')
  })

  it('refuses to resume a session that is still running', async () => {
    registerRunning('peer')

    await expect(run('session_spawn', { prompt: 'go on', resume: 'peer' })).rejects.toThrow('still running')
  })
})
