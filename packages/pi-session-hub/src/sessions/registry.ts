import { createReadStream, rmSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { hubPath, listEntries, listJsonFiles, readJson, writeJsonAtomic } from '../files.js'

/** A running session, written by that session itself at start and removed at shutdown */
export interface SessionRecord {
  id: string
  /** Undefined for an in-memory session; the file itself appears with the first assistant message */
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

/** Sessions run as this user, so a pid owned by anyone else (EPERM) was reused and counts as dead too */
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

/** A record left behind by a process that died without unregistering is removed on sight */
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

/** Pi names every session file `<timestamp>_<id>.jsonl`, with no `_` in the timestamp, so the name finds one unread */
function findSessionFile(id: string): string | undefined {
  const root = join(getAgentDir(), 'sessions')
  for (const project of listEntries(root)) {
    if (!project.isDirectory() && !project.isSymbolicLink()) {
      continue
    }
    const file = listEntries(join(root, project.name)).find(
      entry => entry.name.slice(entry.name.indexOf('_') + 1) === `${id}.jsonl`,
    )
    if (file !== undefined) {
      return join(root, project.name, file.name)
    }
  }

  return undefined
}

/** From the session header, the file's first line; `undefined` when the file does not open with one */
async function readSessionCwd(file: string): Promise<string | undefined> {
  const input = createReadStream(file, 'utf8')
  try {
    for await (const line of createInterface({ input })) {
      const header = JSON.parse(line) as { type?: unknown; cwd?: unknown }

      return header.type === 'session' && typeof header.cwd === 'string' ? header.cwd : undefined
    }

    return undefined
  } finally {
    // Leaving the loop early closes readline but not the file under it
    input.destroy()
  }
}

/** Looks in the running sessions, then in the session files of every project */
export async function findSession(id: string): Promise<StoredSession | undefined> {
  const live = findLiveSession(id)
  if (live?.file !== undefined) {
    return { id, file: live.file, cwd: live.cwd, running: true }
  }
  const file = findSessionFile(id)
  if (file === undefined) {
    return undefined
  }
  const cwd = await readSessionCwd(file)

  return cwd === undefined ? undefined : { id, file, cwd, running: live !== undefined }
}
