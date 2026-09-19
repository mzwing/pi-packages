import type { Ticket } from '../src/state.js'
import { describe, expect, it } from 'vitest'
import { STORE_VERSION, TicketStore } from '../src/store.js'
import { createMemoryFileSystem, goodState, probeTicket } from './helpers.js'

const PATH = '/agent/extensions/pi-codex-enhancer/tickets.json'

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return probeTicket({ capturedAt: 1000, ...overrides })
}

function envelope(tickets: Ticket[], version = STORE_VERSION): string {
  return JSON.stringify({ version, tickets })
}

describe('ticket store', () => {
  it('returns no ticket when the file does not exist', () => {
    const store = new TicketStore({ path: PATH, fileSystem: createMemoryFileSystem() })
    expect(store.read('acct-1', 'gpt-6-astra', 1000)).toBeUndefined()
  })

  it('round-trips a ticket through the file', () => {
    const store = new TicketStore({ path: PATH, fileSystem: createMemoryFileSystem() })
    store.write(ticket())
    expect(store.read('acct-1', 'gpt-6-astra', 1000)?.value).toBe(goodState())
  })

  it('keeps one account and model apart from another', () => {
    const store = new TicketStore({ path: PATH, fileSystem: createMemoryFileSystem() })
    store.write(ticket())
    store.write(ticket({ model: 'gpt-5.6-sol' }))
    store.write(ticket({ accountId: 'acct-2' }))
    expect(store.read('acct-1', 'gpt-6-astra', 1000)).toBeDefined()
    expect(store.read('acct-1', 'gpt-5.6-sol', 1000)).toBeDefined()
    expect(store.read('acct-2', 'gpt-6-astra', 1000)).toBeDefined()
  })

  it('reads the ticket a sibling session wrote after this one loaded', () => {
    const fileSystem = createMemoryFileSystem({ [PATH]: envelope([ticket({ capturedAt: 5000 })]) })
    const store = new TicketStore({ path: PATH, fileSystem })
    expect(store.read('acct-1', 'gpt-6-astra', 5000)?.capturedAt).toBe(5000)
  })

  it("keeps a sibling session's later record rather than overwriting it with an older one", () => {
    const fileSystem = createMemoryFileSystem({ [PATH]: envelope([ticket({ capturedAt: 9000 })]) })
    const store = new TicketStore({ path: PATH, fileSystem })
    store.write(ticket({ capturedAt: 5000 }))
    expect(store.read('acct-1', 'gpt-6-astra', 9000)?.capturedAt).toBe(9000)
  })

  it('drops a record whose hour has already passed', () => {
    const fileSystem = createMemoryFileSystem({ [PATH]: envelope([ticket({ capturedAt: 0 })]) })
    const store = new TicketStore({ path: PATH, fileSystem })
    expect(store.read('acct-1', 'gpt-6-astra', 3_600_000)).toBeUndefined()
  })

  it('drops a record whose stored value is degraded', () => {
    const fileSystem = createMemoryFileSystem({ [PATH]: envelope([ticket({ value: 'z'.repeat(312) })]) })
    const store = new TicketStore({ path: PATH, fileSystem })
    expect(store.read('acct-1', 'gpt-6-astra', 1000)).toBeUndefined()
  })

  it('reads a corrupt file as empty instead of throwing', () => {
    const fileSystem = createMemoryFileSystem({ [PATH]: 'not json' })
    const store = new TicketStore({ path: PATH, fileSystem })
    expect(store.read('acct-1', 'gpt-6-astra', 1000)).toBeUndefined()
    expect(fileSystem.files.get(PATH)).toBe('not json')
  })

  it('reads a file from another version as empty', () => {
    const fileSystem = createMemoryFileSystem({ [PATH]: envelope([ticket()], STORE_VERSION + 1) })
    const store = new TicketStore({ path: PATH, fileSystem })
    expect(store.read('acct-1', 'gpt-6-astra', 1000)).toBeUndefined()
  })

  it('writes through a temporary file so a reader never sees a half-written one', () => {
    const fileSystem = createMemoryFileSystem()
    const store = new TicketStore({ path: PATH, fileSystem })
    store.write(ticket())
    expect([...fileSystem.files.keys()]).toEqual([PATH])
  })

  it('removes the temporary file when the rename fails', () => {
    const fileSystem = createMemoryFileSystem()
    fileSystem.rename = () => {
      throw new Error('cross-device link')
    }
    const store = new TicketStore({ path: PATH, fileSystem })
    expect(() => store.write(ticket())).toThrow('cross-device link')
    expect([...fileSystem.files.keys()]).toEqual([])
  })

  it('forgets one key without touching the others', () => {
    const store = new TicketStore({ path: PATH, fileSystem: createMemoryFileSystem() })
    store.write(ticket())
    store.write(ticket({ accountId: 'acct-2' }))
    store.forget('acct-1', 'gpt-6-astra', 1000)
    expect(store.read('acct-1', 'gpt-6-astra', 1000)).toBeUndefined()
    expect(store.read('acct-2', 'gpt-6-astra', 1000)).toBeDefined()
  })

  it('names the file under the agent directory when no path is given', () => {
    const store = new TicketStore({ agentDir: '/agent', fileSystem: createMemoryFileSystem() })
    expect(store.path()).toBe(PATH)
  })
})
