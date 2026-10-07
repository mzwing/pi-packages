import type { TranscriptOptions } from './transcript.js'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { StringEnum } from '@earendil-works/pi-ai'
import { defineTool, SessionManager } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { sendMail } from './mailbox.js'
import { findLiveSession, findSession, listLiveSessions } from './registry.js'
import { logPath, spawnSession } from './spawn.js'
import { readTranscript } from './transcript.js'

const RECENT_LIMIT = 10
export const DEFAULT_TRANSCRIPT: TranscriptOptions = { last: 20, tools: false }
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const COMMAND_OR_FILE_PROMPT = /^\s*[/@]/

function textResult(text: string): { content: { type: 'text'; text: string }[]; details: undefined } {
  return { content: [{ type: 'text', text }], details: undefined }
}

function label(session: { id: string; name?: string | undefined }): string {
  return session.name === undefined ? session.id : `${session.id} "${session.name}"`
}

export async function describeSessions(ctx: ExtensionContext): Promise<string> {
  const own = ctx.sessionManager.getSessionId()
  const live = listLiveSessions()
  const running = new Set(live.map(record => record.id))
  const recent = (await SessionManager.list(ctx.cwd))
    .sort((left, right) => right.modified.getTime() - left.modified.getTime())
    .slice(0, RECENT_LIMIT)

  return [
    'Running sessions:',
    ...live.map(record => `- ${label(record)} · ${record.cwd}${record.id === own ? ' · this session' : ''}`),
    '',
    'Recent sessions of this project:',
    ...recent.map(
      info =>
        `- ${label(info)} · ${info.messageCount} messages · ${info.modified.toISOString()}${running.has(info.id) ? ' · running' : ''}`,
    ),
  ].join('\n')
}

/** `undefined` when no session has the id. */
export async function describeTranscript(
  id: string,
  cwd: string,
  options: TranscriptOptions,
): Promise<string | undefined> {
  const session = await findSession(id, cwd)
  if (session === undefined) {
    return undefined
  }
  if (!existsSync(session.file)) {
    return `Session ${id} has no messages yet.`
  }

  return `Transcript of ${id}${session.running ? ' (running)' : ''}:\n\n${readTranscript(session.file, options)}`
}

export function registerSessionTools(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: 'session_list',
      label: 'Sessions',
      description:
        'List the running Pi sessions on this machine and the recent sessions of this project. Their ids work with session_read, session_send and session_spawn.',
      parameters: Type.Object({}),
      execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => textResult(await describeSessions(ctx)),
    }),
  )

  pi.registerTool(
    defineTool({
      name: 'session_read',
      label: 'Read session',
      description:
        "Read another session's conversation as its model sees it: user and assistant text and tool calls, newest last.",
      parameters: Type.Object({
        session: Type.String({ description: 'Session id' }),
        last: Type.Optional(
          Type.Integer({
            minimum: 1,
            description: `How many items to show, newest last (default ${DEFAULT_TRANSCRIPT.last})`,
          }),
        ),
        tools: Type.Optional(Type.Boolean({ description: 'Include tool results (default false)' })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const transcript = await describeTranscript(params.session, ctx.cwd, {
          last: params.last ?? DEFAULT_TRANSCRIPT.last,
          tools: params.tools ?? DEFAULT_TRANSCRIPT.tools,
        })
        if (transcript === undefined) {
          throw new Error(`No session has the id ${params.session}.`)
        }

        return textResult(transcript)
      },
    }),
  )

  pi.registerTool(
    defineTool({
      name: 'session_send',
      label: 'Message session',
      description:
        'Send a message to one running session. It arrives there as a message from this session, and starts a turn unless wake is false.',
      parameters: Type.Object({
        to: Type.String({ description: 'Id of a running session' }),
        message: Type.String(),
        wake: Type.Optional(
          Type.Boolean({
            description: "Start a turn in the recipient now (default true); false waits for the recipient's next turn",
          }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const from = ctx.sessionManager.getSessionId()
        if (params.to === from) {
          throw new Error('A session cannot message itself.')
        }
        const recipient = findLiveSession(params.to)
        if (recipient === undefined) {
          throw new Error(`Session ${params.to} is not running. Continue it with session_spawn and resume.`)
        }
        const { woke } = await sendMail({
          from,
          fromName: ctx.sessionManager.getSessionName(),
          to: params.to,
          body: params.message,
          wake: params.wake ?? true,
        })

        return textResult(
          woke
            ? `Delivered to ${label(recipient)}.`
            : `Queued for ${label(recipient)}, which reads it when it next starts.`,
        )
      },
    }),
  )

  pi.registerTool(
    defineTool({
      name: 'session_spawn',
      label: 'Start session',
      description:
        'Start an independent headless Pi session that runs the prompt to completion and outlives this one. It is not a subagent and returns nothing here: follow it with session_read. With resume, continue a stopped session instead.',
      parameters: Type.Object({
        prompt: Type.String(),
        cwd: Type.Optional(
          Type.String({ description: "Working directory, relative to this session's (default: this session's)" }),
        ),
        name: Type.Optional(Type.String({ description: 'Session name' })),
        model: Type.Optional(Type.String({ description: 'provider/model (default: the Pi default)' })),
        thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
        resume: Type.Optional(Type.String({ description: 'Id of a stopped session to continue with the prompt' })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        if (COMMAND_OR_FILE_PROMPT.test(params.prompt)) {
          throw new Error('A prompt starting with "/" or "@" would run a command or attach a file there; reword it.')
        }
        let sessionId: string = randomUUID()
        let cwd = resolve(ctx.cwd, params.cwd ?? '.')
        if (params.resume !== undefined) {
          const session = await findSession(params.resume, ctx.cwd)
          if (session === undefined) {
            throw new Error(`No session has the id ${params.resume}.`)
          }
          if (session.running) {
            throw new Error(`Session ${params.resume} is still running; message it with session_send.`)
          }
          sessionId = session.id
          cwd = session.cwd
        }
        const child = spawnSession({
          cwd,
          sessionId,
          prompt: params.prompt,
          name: params.name,
          model: params.model,
          thinking: params.thinking,
        })
        if (child.pid === undefined) {
          throw new Error(`Could not start pi; see ${logPath(sessionId)}.`)
        }
        child.unref()

        return textResult(
          `Started session ${sessionId} in ${cwd} (pid ${child.pid}). Follow it with session_read; its process output goes to ${logPath(sessionId)}.`,
        )
      },
    }),
  )
}
