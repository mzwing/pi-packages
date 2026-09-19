import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createProbeTransport, createProxyAgent, normalizeHeaders } from '../src/probe.js'
import { TURN_STATE_HEADER } from '../src/state.js'
import { goodState } from './helpers.js'

let server: Server
let origin: string
let bodyRead = false
let hold = false

beforeAll(async () => {
  server = createServer((request, response) => {
    request.on('data', () => {
      bodyRead = true
    })
    if (hold) {
      return
    }
    if (request.url === '/empty') {
      response.writeHead(200)
    } else if (request.url === '/rate-limited') {
      response.writeHead(429, { [TURN_STATE_HEADER]: goodState() })
    } else {
      response.writeHead(200, { [TURN_STATE_HEADER]: goodState(), 'X-Mixed-Case': 'yes' })
    }
    response.write('data: {"type":"response.created"}\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  origin = typeof address === 'object' && address !== null ? `http://127.0.0.1:${address.port}` : ''
})

afterAll(async () => {
  await new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
})

function call(path: string, timeoutMs = 2000): Parameters<ReturnType<typeof createProbeTransport>>[0] {
  return {
    url: `${origin}${path}`,
    headers: { 'content-type': 'application/json' },
    body: '{"model":"gpt-6-astra"}',
    timeoutMs,
    proxyUrl: '',
  }
}

describe('normalizeHeaders', () => {
  it('lower-cases the names', () => {
    expect(normalizeHeaders({ 'X-Codex-Turn-State': 'abc' })).toEqual({ 'x-codex-turn-state': 'abc' })
  })

  it('joins a repeated header so one value always comes back', () => {
    expect(normalizeHeaders({ 'set-cookie': ['a=1', 'b=2'] })['set-cookie']).toBe('a=1, b=2')
  })

  it('drops a header with no value', () => {
    expect(normalizeHeaders({ 'x-empty': undefined })).toEqual({})
  })
})

describe('createProbeTransport', () => {
  it('returns the status and the state header', async () => {
    const reply = await createProbeTransport()(call('/codex/responses'))
    expect(reply.status).toBe(200)
    expect(reply.headers[TURN_STATE_HEADER]).toBe(goodState())
  })

  it('lower-cases the header names it returns', async () => {
    const reply = await createProbeTransport()(call('/codex/responses'))
    expect(reply.headers['x-mixed-case']).toBe('yes')
  })

  it('reports a non-200 with its status rather than throwing', async () => {
    expect((await createProbeTransport()(call('/rate-limited'))).status).toBe(429)
  })

  it('reports a response that carries no state header', async () => {
    expect((await createProbeTransport()(call('/empty'))).headers[TURN_STATE_HEADER]).toBeUndefined()
  })

  it('sends the body so the backend can mint against it', async () => {
    bodyRead = false
    await createProbeTransport()(call('/codex/responses'))
    expect(bodyRead).toBe(true)
  })

  it('gives up when the backend never answers', async () => {
    hold = true
    await expect(createProbeTransport()(call('/codex/responses', 100))).rejects.toThrow('timed out')
    hold = false
  })

  it('reports a refused connection instead of hanging', async () => {
    const transport = createProbeTransport()
    await expect(
      transport({ ...call('/codex/responses'), url: 'http://127.0.0.1:1/codex/responses' }),
    ).rejects.toThrow()
  })
})

describe('createProxyAgent', () => {
  it('builds no agent when no proxy is configured', async () => {
    expect(await createProxyAgent('', 'https://chatgpt.com/backend-api/codex/responses')).toBeUndefined()
  })

  it('tunnels an https target through an http proxy', async () => {
    const agent = await createProxyAgent('http://127.0.0.1:8080', 'https://chatgpt.com/x')
    expect(agent?.constructor.name).toBe('HttpsProxyAgent')
  })

  it('uses a plain proxy for a plain target, because a relay can be local', async () => {
    const agent = await createProxyAgent('http://127.0.0.1:8080', 'http://127.0.0.1:3001/x')
    expect(agent?.constructor.name).toBe('HttpProxyAgent')
  })

  it('serves either target through a socks proxy', async () => {
    const agent = await createProxyAgent('socks5h://127.0.0.1:1080', 'https://chatgpt.com/x')
    expect(agent?.constructor.name).toBe('SocksProxyAgent')
  })

  it('reuses the agent it already built', async () => {
    const first = await createProxyAgent('socks5h://127.0.0.1:1081', 'https://chatgpt.com/x')
    const second = await createProxyAgent('socks5h://127.0.0.1:1081', 'https://chatgpt.com/x')
    expect(first).toBe(second)
  })

  it('refuses a proxy URL it cannot build an agent for, without echoing it', async () => {
    await expect(createProxyAgent('ftp://user:secret@host', 'https://chatgpt.com/x')).rejects.toThrow(
      'probe proxy URL is unusable',
    )
  })
})
