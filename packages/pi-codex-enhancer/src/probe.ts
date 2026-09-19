import type { Agent, IncomingHttpHeaders } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { proxyUrlProblem } from './config.js'

export interface ProbeCall {
  url: string
  headers: Record<string, string>
  body: string
  timeoutMs: number
  proxyUrl: string
  signal?: AbortSignal | undefined
}

export interface ProbeReply {
  status: number
  headers: Record<string, string>
}

export type ProbeTransport = (call: ProbeCall) => Promise<ProbeReply>

const agents = new Map<string, Agent>()

export function normalizeHeaders(raw: IncomingHttpHeaders): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      headers[name.toLowerCase()] = value
    } else if (Array.isArray(value)) {
      headers[name.toLowerCase()] = value.join(', ')
    }
  }

  return headers
}

/**
 * Loaded on demand, so a session that configures no proxy never pays for the agent packages. The
 * scheme of the *target* picks the tunnel for http and https; a socks proxy serves both.
 */
export async function createProxyAgent(proxyUrl: string, targetUrl: string): Promise<Agent | undefined> {
  const url = proxyUrl.trim()
  if (url.length === 0) {
    return undefined
  }
  if (proxyUrlProblem(url) !== undefined) {
    throw new Error('probe proxy URL is unusable')
  }
  const secureTarget = new URL(targetUrl).protocol === 'https:'
  const cacheKey = `${secureTarget ? 'https' : 'http'} ${url}`
  const cached = agents.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }

  let agent: Agent
  if (new URL(url).protocol.startsWith('socks')) {
    agent = new (await import('socks-proxy-agent')).SocksProxyAgent(url)
  } else if (secureTarget) {
    agent = new (await import('https-proxy-agent')).HttpsProxyAgent(url)
  } else {
    agent = new (await import('http-proxy-agent')).HttpProxyAgent(url)
  }
  agents.set(cacheKey, agent)

  return agent
}

async function send(call: ProbeCall, agent: Agent | undefined): Promise<ProbeReply> {
  const request = new URL(call.url).protocol === 'https:' ? httpsRequest : httpRequest

  return new Promise<ProbeReply>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    // `agent: false` gives this request a throwaway socket, so destroying the response below cannot
    // poison a pooled connection Pi would go on to use.
    const client = request(
      call.url,
      { agent: agent ?? false, headers: call.headers, method: 'POST', signal: call.signal },
      response => {
        clearTimeout(timer)
        const headers = normalizeHeaders(response.headers)
        // Only the headers carry the state; reading the event stream would spend the turn for nothing.
        response.destroy()
        resolve({ status: response.statusCode ?? 0, headers })
      },
    )
    timer = setTimeout(() => client.destroy(new Error(`probe timed out after ${call.timeoutMs}ms`)), call.timeoutMs)
    client.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    client.end(call.body)
  })
}

export function createProbeTransport(): ProbeTransport {
  return async call => send(call, await createProxyAgent(call.proxyUrl, call.url))
}
