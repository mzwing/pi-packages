import { spawn } from 'node:child_process'
import process from 'node:process'
import { describe, expect, it, vi } from 'vitest'
import { spawnSession } from '../src/spawn.js'
import { useAgentDir } from './helpers.js'

vi.mock('node:child_process', () => ({ spawn: vi.fn(() => ({ pid: 4242, on: vi.fn() })) }))

describe('spawnSession', () => {
  useAgentDir()

  it('starts a detached print-mode pi with stdin closed and the prompt behind --', () => {
    spawnSession({
      cwd: '/workspace',
      sessionId: 'task-1',
      prompt: '--help is a fine prompt here',
      name: 'T1 executor',
      model: 'faux/faux-1',
      tools: ['read', 'task_show'],
      args: ['--no-approve'],
    })

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        process.argv[1],
        '--print',
        '--session-id',
        'task-1',
        '--name',
        'T1 executor',
        '--model',
        'faux/faux-1',
        '--tools',
        'read,task_show',
        '--no-approve',
        '--',
        '--help is a fine prompt here',
      ],
      expect.objectContaining({
        cwd: '/workspace',
        detached: true,
        stdio: ['ignore', expect.any(Number), expect.any(Number)],
      }),
    )
  })

  it('names the session it works for, which pi-permission-system sends its permission asks to', () => {
    spawnSession({ cwd: '/workspace', sessionId: 'task-1', prompt: 'go', parentSessionId: 'coordinator-1' })

    expect(vi.mocked(spawn).mock.calls.at(-1)?.[2]?.env?.['PI_SUBAGENT_PARENT_SESSION']).toBe('coordinator-1')
  })
})
