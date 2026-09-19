import { describe, expect, it } from 'vitest'
import {
  buildEnhancerJsonSchema,
  DEFAULT_CONFIG,
  getEnhancerConfigPaths,
  getTicketStorePath,
  loadEnhancerConfig,
  maskProxyUrl,
  proxyUrlProblem,
  readPiTransport,
} from '../src/config.js'

const { globalPath, projectPath } = getEnhancerConfigPaths('/workspace', '/agent')

function load(files: Record<string, string>): ReturnType<typeof loadEnhancerConfig> {
  return loadEnhancerConfig({ cwd: '/workspace', agentDir: '/agent', readFile: path => files[path] })
}

function transport(files: Record<string, string>): ReturnType<typeof readPiTransport> {
  return readPiTransport({ cwd: '/workspace', agentDir: '/agent', readFile: path => files[path] })
}

describe('loadEnhancerConfig', () => {
  it('falls back to the defaults when neither scope exists', () => {
    expect(load({}).config).toEqual(DEFAULT_CONFIG)
  })

  it('lets the project scope override the global one', () => {
    const result = load({
      [globalPath]: JSON.stringify({ probeTimeoutMs: 3000, notify: false }),
      [projectPath]: JSON.stringify({ probeTimeoutMs: 12_000 }),
    })
    expect(result.config?.probeTimeoutMs).toBe(12_000)
    expect(result.config?.notify).toBe(false)
  })

  it('rejects an unknown key so a typo is not silently ignored', () => {
    const result = load({ [globalPath]: JSON.stringify({ probeTimeout: 3000 }) })
    expect(result.config).toBeUndefined()
    expect(result.issues[0]?.message).toContain('probeTimeout')
  })

  it('records invalid JSON and yields no config rather than a half-applied one', () => {
    const result = load({ [projectPath]: '{' })
    expect(result.config).toBeUndefined()
    expect(result.issues[0]?.message).toContain('invalid JSON')
  })

  it('refuses a probe timeout no request could absorb', () => {
    expect(load({ [globalPath]: JSON.stringify({ probeTimeoutMs: 120_000 }) }).config).toBeUndefined()
  })

  it('refuses a probe interval short enough to spend the quota', () => {
    expect(load({ [globalPath]: JSON.stringify({ minProbeIntervalMs: 500 }) }).config).toBeUndefined()
  })

  it('reports a proxy URL carrying a path as an issue', () => {
    const result = load({ [globalPath]: JSON.stringify({ probeProxyUrl: 'http://host:8080/path' }) })
    expect(result.config).toBeUndefined()
    expect(result.issues[0]?.message).toContain('probeProxyUrl')
  })

  it('accepts a socks proxy with credentials', () => {
    const result = load({ [globalPath]: JSON.stringify({ probeProxyUrl: 'socks5h://user:pass@host:1080' }) })
    expect(result.config?.probeProxyUrl).toBe('socks5h://user:pass@host:1080')
  })

  it('surfaces a read failure without throwing', () => {
    const result = loadEnhancerConfig({
      cwd: '/workspace',
      agentDir: '/agent',
      readFile: () => {
        throw new Error('EACCES')
      },
    })
    expect(result.config).toBeUndefined()
    expect(result.issues[0]?.message).toBe('EACCES')
  })
})

describe('proxyUrlProblem', () => {
  it('accepts an empty value, because no proxy is the default', () => {
    expect(proxyUrlProblem('')).toBeUndefined()
  })

  it('refuses a scheme it cannot build an agent for', () => {
    expect(proxyUrlProblem('ftp://host:21')).toContain('scheme')
  })

  it('refuses a value that names no host', () => {
    expect(proxyUrlProblem('http://')).toBeDefined()
  })

  it('refuses a query or a fragment', () => {
    expect(proxyUrlProblem('http://host?a=1')).toContain('query')
    expect(proxyUrlProblem('http://host#a')).toContain('fragment')
  })
})

describe('maskProxyUrl', () => {
  it('never returns the password', () => {
    expect(maskProxyUrl('socks5h://user:secret@host:1080')).not.toContain('secret')
    expect(maskProxyUrl('socks5h://user:secret@host:1080')).toContain('***')
  })

  it('returns nothing for a value it would refuse anyway', () => {
    expect(maskProxyUrl('ftp://host/x?y=1')).toBe('')
  })
})

describe('readPiTransport', () => {
  it('prefers the project scope over the global one', () => {
    expect(
      transport({
        '/agent/settings.json': JSON.stringify({ transport: 'websocket' }),
        '/workspace/.pi/settings.json': JSON.stringify({ transport: 'sse' }),
      }),
    ).toBe('sse')
  })

  it('reports auto when no settings file names one', () => {
    expect(transport({})).toBe('auto')
  })

  it('reports auto when the settings file is unreadable or names something unknown', () => {
    expect(transport({ '/agent/settings.json': '{' })).toBe('auto')
    expect(transport({ '/agent/settings.json': JSON.stringify({ transport: 'carrier-pigeon' }) })).toBe('auto')
  })
})

describe('paths', () => {
  it('puts the config and the tickets under the extension directory', () => {
    expect(globalPath).toBe('/agent/extensions/pi-codex-enhancer/config.json')
    expect(projectPath).toBe('/workspace/.pi/extensions/pi-codex-enhancer/config.json')
    expect(getTicketStorePath('/agent')).toBe('/agent/extensions/pi-codex-enhancer/tickets.json')
  })
})

describe('buildEnhancerJsonSchema', () => {
  it('publishes a schema that carries its own id', () => {
    const schema = buildEnhancerJsonSchema()
    expect(schema['$id']).toContain('pi-codex-enhancer')
    expect(schema['additionalProperties']).toBe(false)
  })
})
