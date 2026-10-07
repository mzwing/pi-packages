import type { Server } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { hubPath, listJsonFiles, readJson, writeJsonAtomic } from './files.js'

/** Emitted on `pi.events` in the recipient for every mail it hands to its model. */
export const MAIL_EVENT = 'session-hub:mail'

export interface Mail {
  id: string
  from: string
  fromName: string | undefined
  to: string
  body: string
  /** Start a turn in the recipient on delivery, rather than waiting for its next one. */
  wake: boolean
  sentAt: number
}

export type OutgoingMail = Omit<Mail, 'id' | 'sentAt'>

function queueDirectory(sessionId: string): string {
  return hubPath('mail', sessionId)
}

function mailPath(mail: Mail): string {
  return join(queueDirectory(mail.to), `${mail.sentAt}-${mail.id}.json`)
}

/** Unix socket paths are capped near 100 bytes, so the socket is named by a short hash of the session id. */
function socketPath(sessionId: string): string {
  return hubPath('sock', `${createHash('sha256').update(sessionId).digest('hex').slice(0, 16)}.sock`)
}

export function readQueue(sessionId: string): Mail[] {
  const directory = queueDirectory(sessionId)

  return listJsonFiles(directory).flatMap(name => readJson<Mail>(join(directory, name)) ?? [])
}

export function removeMail(mail: Mail): void {
  rmSync(mailPath(mail), { force: true })
}

/** False when nothing listens; the mail then waits for the recipient's next start. */
async function poke(sessionId: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection(socketPath(sessionId))
    socket.on('connect', () => {
      socket.end()
      resolve(true)
    })
    socket.on('error', () => resolve(false))
  })
}

/** The queued file is the message; the poke only wakes a running recipient to read it now. */
export async function sendMail(outgoing: OutgoingMail): Promise<{ mail: Mail; woke: boolean }> {
  const mail: Mail = { ...outgoing, id: randomUUID(), sentAt: Date.now() }
  writeJsonAtomic(mailPath(mail), mail)

  return { mail, woke: await poke(mail.to) }
}

export async function listenForMail(sessionId: string, onMail: () => void): Promise<Server> {
  const path = socketPath(sessionId)
  mkdirSync(dirname(path), { recursive: true })
  // A socket file outlives a crashed listener and would refuse the new one.
  rmSync(path, { force: true })
  const server = createServer(socket => {
    socket.end()
    onMail()
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => resolve(server))
  })
}

export function stopListening(server: Server, sessionId: string): void {
  server.close()
  rmSync(socketPath(sessionId), { force: true })
}
