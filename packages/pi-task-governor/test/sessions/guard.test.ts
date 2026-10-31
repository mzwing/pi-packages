import type { Runtime } from '../../src/sessions/runtime.js'
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/config.js'
import { governBash, shimDirectory, writeRefusal, writeShims } from '../../src/sessions/guard.js'
import { initStore, readState, storeDirectory, updateState } from '../../src/tasks/store.js'
import { claimRoot, declareRoot } from '../../src/tasks/task.js'
import { PARSER_SPEC, useWorkspace } from '../helpers.js'

describe('guard', () => {
  const workspace = useWorkspace()

  function governedStore(): string {
    const store = storeDirectory(workspace.repo)
    initStore(store, DEFAULT_CONFIG)
    updateState(store, state => {
      declareRoot(state, PARSER_SPEC, 'main', [], 'boss', 1)
      claimRoot(
        state,
        'T1',
        { sessionId: 'executor', pid: 1, workspace: { name: 'task-T1', path: '/ws/T1' }, sessions: 0 },
        2,
      )
    })
    writeShims(store)

    return store
  }

  function runtime(store: string, role: Runtime['role']): Runtime {
    return { store, repoRoot: workspace.repo, sessionId: 'me', role, environment: {} }
  }

  async function runBash(current: Runtime, command: string): Promise<string> {
    let bash: ToolDefinition | undefined
    const pi = { registerTool: (tool: ToolDefinition) => (bash = tool) }
    const context = {
      cwd: workspace.repo,
      isProjectTrusted: () => false,
      sessionManager: { getSessionId: () => 'me', getSessionFile: () => undefined },
      model: undefined,
    }
    governBash(pi as unknown as ExtensionAPI, context as never, () => current)
    const result = await bash!.execute('call', { command }, undefined, undefined, context as never)

    return (result.content[0] as { text: string }).text
  }

  it('answers git, jj and pi from the shims, however they are reached through PATH', () => {
    const store = governedStore()
    const env = { ...process.env, PATH: `${shimDirectory(store)}:${process.env['PATH']}` }

    for (const command of ['git status', 'jj log', 'sh -c "pi -p hi"', 'echo x | xargs git add']) {
      const result = spawnSync('sh', ['-c', command], { env, encoding: 'utf8' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('blocked in this governed session')
    }
  })

  it('keeps writes out of task workspaces and version-control metadata', () => {
    const state = readState(governedStore())
    const coordinator = runtime('', 'coordinator')
    const developer = runtime('', 'developer')

    expect(writeRefusal(state, coordinator, '/ws/T1/src/a.ts', undefined)).toContain('belong to their executors')
    expect(writeRefusal(state, coordinator, '/project/src/a.ts', undefined)).toBeUndefined()
    expect(writeRefusal(state, coordinator, '/project/.jj/repo/store', undefined)).toContain('metadata')
    expect(writeRefusal(state, developer, '/ws/T1/src/a.ts', '/ws/T1')).toBeUndefined()
    expect(writeRefusal(state, developer, join(tmpdir(), 'scratch.txt'), '/ws/T1')).toBeUndefined()
    expect(writeRefusal(state, developer, '/project/src/a.ts', '/ws/T1')).toContain('only inside its task workspace')
    expect(writeRefusal(state, developer, '/ws/T1/.git/config', '/ws/T1')).toContain('metadata')
  })

  it('runs bash with the shims first on PATH and the task environment applied', async () => {
    const store = governedStore()
    vi.stubEnv('HOME_HINT', 'set')
    const output = await runBash(
      { ...runtime(store, 'developer'), environment: { TASK_FLAG: 'on', HOME_HINT: null } },
      'printf "%s\\n%s\\n" "$PATH" "$TASK_FLAG"; printenv HOME_HINT || echo unset',
    )
    const [path, flag, hint] = output.split('\n')

    expect(path?.startsWith(`${shimDirectory(store)}:`)).toBe(true)
    expect(flag).toBe('on')
    expect(hint).toBe('unset')
  })

  it('keeps the coordinator, and a session a human unlocked, off the shims', async () => {
    const store = governedStore()
    const path = async (role: Runtime['role']): Promise<string> => runBash(runtime(store, role), 'printf %s "$PATH"')

    expect(await path('coordinator')).not.toContain(shimDirectory(store))
    expect(await path(undefined)).toContain(shimDirectory(store))
    updateState(store, state => {
      state.unlocks['me'] = Date.now() + 60_000
    })
    expect(await path(undefined)).not.toContain(shimDirectory(store))
  })
})
