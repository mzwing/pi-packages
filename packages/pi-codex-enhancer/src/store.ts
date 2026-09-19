import type { Ticket } from './state.js'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getTicketStorePath } from './config.js'
import { isUsable, newerTicket, ticketKey } from './state.js'

export const STORE_VERSION = 1

interface StoreEnvelope {
  version: number
  tickets: Ticket[]
}

export interface TicketFileSystem {
  readFile: (path: string) => string | undefined
  writeFile: (path: string, data: string) => void
  rename: (from: string, to: string) => void
  mkdir: (path: string) => void
  unlink: (path: string) => void
}

export interface TicketStoreOptions {
  path?: string | undefined
  agentDir?: string | undefined
  fileSystem?: TicketFileSystem | undefined
}

const defaultFileSystem: TicketFileSystem = {
  readFile(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return undefined
      }
      throw error
    }
  },
  writeFile(path, data) {
    // A ticket is bearer material, so the file is owner-only from the moment it exists.
    writeFileSync(path, data, { encoding: 'utf8', mode: 0o600 })
  },
  rename(from, to) {
    renameSync(from, to)
  },
  mkdir(path) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
  },
  unlink(path) {
    unlinkSync(path)
  },
}

function isTicket(value: unknown): value is Ticket {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Partial<Ticket>

  return (
    typeof candidate.accountId === 'string' &&
    typeof candidate.model === 'string' &&
    typeof candidate.value === 'string' &&
    typeof candidate.capturedAt === 'number' &&
    (candidate.source === 'probe' || candidate.source === 'response')
  )
}

/**
 * Shared across concurrent Pi sessions: the hour-long lifetime and the real cost of a probe make one
 * mint per window worth persisting, and a session that starts cold reads a sibling's ticket instead
 * of buying its own.
 */
export class TicketStore {
  private readonly filePath: string
  private readonly fileSystem: TicketFileSystem

  constructor(options: TicketStoreOptions = {}) {
    this.filePath = options.path ?? getTicketStorePath(options.agentDir)
    this.fileSystem = options.fileSystem ?? defaultFileSystem
  }

  path(): string {
    return this.filePath
  }

  read(accountId: string, model: string, now: number): Ticket | undefined {
    const key = ticketKey(accountId, model)

    return this.all(now).find(ticket => ticketKey(ticket.accountId, ticket.model) === key)
  }

  /** Re-reads first, so another session's fresher record wins and other keys survive the write. */
  write(ticket: Ticket): void {
    const key = ticketKey(ticket.accountId, ticket.model)
    const existing = this.all(ticket.capturedAt)
    const current = existing.find(candidate => ticketKey(candidate.accountId, candidate.model) === key)
    const kept = existing.filter(candidate => ticketKey(candidate.accountId, candidate.model) !== key)
    kept.push(newerTicket(current, ticket) ?? ticket)
    this.persist(kept)
  }

  forget(accountId: string, model: string, now: number): void {
    const key = ticketKey(accountId, model)
    this.persist(this.all(now).filter(ticket => ticketKey(ticket.accountId, ticket.model) !== key))
  }

  /**
   * A corrupt or foreign-version file reads as empty and is left on disk: the next write replaces
   * it, and destroying a copy another session may still read is not an improvement.
   */
  private all(now: number): Ticket[] {
    let raw: string | undefined
    try {
      raw = this.fileSystem.readFile(this.filePath)
    } catch {
      return []
    }
    if (raw === undefined) {
      return []
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return []
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return []
    }

    const envelope = parsed as Partial<StoreEnvelope>
    if (envelope.version !== STORE_VERSION || !Array.isArray(envelope.tickets)) {
      return []
    }

    return envelope.tickets.filter(ticket => isTicket(ticket) && isUsable(ticket, now))
  }

  private persist(tickets: Ticket[]): void {
    const envelope: StoreEnvelope = { version: STORE_VERSION, tickets }
    const temporary = `${this.filePath}.tmp`
    try {
      this.fileSystem.mkdir(dirname(this.filePath))
      this.fileSystem.writeFile(temporary, `${JSON.stringify(envelope)}\n`)
      this.fileSystem.rename(temporary, this.filePath)
    } catch (error) {
      try {
        this.fileSystem.unlink(temporary)
      } catch {
        // The write error is the actionable one; a failed cleanup is not.
      }
      throw error
    }
  }
}
