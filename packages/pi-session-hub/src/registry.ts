import { rmSync } from 'node:fs'
import process from 'node:process'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { hubPath, listJsonFiles, readJson, writeJsonAtomic } from './files.js'

/** A running session, written by that session itself at start and removed at shutdown. */
export interface SessionRecord {
  id: string
  /** Undefined for an in-memory session; the file itself appears with the first assistant message. */
  file: string | undefined
  cwd: string
  name: string | undefined
  pid: number
}

export interface StoredSession {
  id: string
  file: string
  cwd: string
  running: boolean
}

function recordPath(id: string): string {
  return hubPath('registry', `${id}.json`)
}

/** Sessions run as this user, so a pid owned by anyone else (EPERM) was reused and counts as dead too. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  } catch {
    return false
  }
}

export function registerSession(record: SessionRecord): void {
  writeJsonAtomic(recordPath(record.id), record)
}

export function unregisterSession(id: string): void {
  rmSync(recordPath(id), { force: true })
}

/** A record left behind by a process that died without unregistering is removed on sight. */
export function findLiveSession(id: string): SessionRecord | undefined {
  const record = readJson<SessionRecord>(recordPath(id))
  if (record === undefined) {
    return undefined
  }
  if (isAlive(record.pid)) {
    return record
  }
  unregisterSession(id)

  return undefined
}

export function listLiveSessions(): SessionRecord[] {
  return listJsonFiles(hubPath('registry')).flatMap(name => findLiveSession(name.slice(0, -'.json'.length)) ?? [])
}

/** Looks in the running sessions, then this project's sessions, then every project's. */
export async function findSession(id: string, cwd: string): Promise<StoredSession | undefined> {
  const live = findLiveSession(id)
  if (live?.file !== undefined) {
    return { id, file: live.file, cwd: live.cwd, running: true }
  }
  const running = live !== undefined
  const local = SessionManager.findById(cwd, id)
  if (local !== undefined) {
    return { id, file: local, cwd, running }
  }
  const found = (await SessionManager.listAll()).find(info => info.id === id)

  return found === undefined ? undefined : { id, file: found.path, cwd: found.cwd, running }
}
