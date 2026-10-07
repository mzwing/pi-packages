import type { Runtime } from '../src/runtime.js'
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config.js'
import { blockedCommand, governBash, registerGuard, shimDirectory, writeRefusal, writeShims } from '../src/guard.js'
import { initStore, readState, storeDirectory, updateState } from '../src/store.js'
import { claimRoot, declareRoot } from '../src/task.js'
import { PARSER_SPEC, useWorkspace } from './helpers.js'

describe('blocked commands', () => {
  it.each([
    '/usr/bin/git status',
    'cd src && ./node_modules/.bin/jj log',
    'env A=1 /nix/store/abc-git-2.55.0/bin/git log',
    'nix run nixpkgs#git -- status',
    'nix shell nixpkgs#jujutsu -c jj st',
    'cat .jj/repo/store/type',
    'rm -rf .git',
    'ls ../project/.jj',
  ])('blocks %s', command => {
    expect(blockedCommand(command)).toBe(true)
  })

  // Bare names go through PATH, where the shims answer them.
  it.each(['git status', 'cat .gitignore', 'ls .github/workflows', 'grep -rn "git" src', 'cat src/pi.ts'])(
    'leaves %s to the shims or alone',
    command => {
      expect(blockedCommand(command)).toBe(false)
    },
  )
})

describe('guard', () => {
  const workspace = useWorkspace()

  function governedStore(): string {
    const store = storeDirectory(workspace.repo)
    initStore(store, DEFAULT_CONFIG)
    updateState(store, state => {
      declareRoot(state, PARSER_SPEC, 'main', 'boss', 1)
      claimRoot(
        state,
        'T1',
        { sessionId: 'executor', pid: 1, workspace: { name: 'task-T1', path: '/ws/T1' }, restarts: 0 },
        2,
      )
    })
    writeShims(store)

    return store
  }

  function runtime(store: string, role: Runtime['role']): Runtime {
    return { store, repoRoot: workspace.repo, sessionId: 'me', role, environment: {} }
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

  it('blocks paths to the binaries until a human unlocks the session', () => {
    const store = governedStore()
    let handler: (event: unknown, context: unknown) => unknown = () => undefined
    const pi = { on: (_name: string, registered: typeof handler) => (handler = registered) }
    registerGuard(pi as unknown as ExtensionAPI, () => runtime(store, undefined))
    const call = { type: 'tool_call', toolCallId: 'c', toolName: 'bash', input: { command: '/usr/bin/git push' } }

    expect(handler(call, { cwd: workspace.repo })).toMatchObject({ block: true })
    updateState(store, state => {
      state.unlocks['me'] = Date.now() + 60_000
    })
    expect(handler(call, { cwd: workspace.repo })).toBeUndefined()
  })

  it('runs bash with the shims first on PATH and the task environment applied', async () => {
    const store = governedStore()
    vi.stubEnv('HOME_HINT', 'set')
    let bash: ToolDefinition | undefined
    const pi = { registerTool: (tool: ToolDefinition) => (bash = tool) }
    const context = {
      cwd: workspace.repo,
      isProjectTrusted: () => false,
      sessionManager: { getSessionId: () => 'me', getSessionFile: () => undefined },
      model: undefined,
    }
    governBash(pi as unknown as ExtensionAPI, context as never, () => ({
      ...runtime(store, 'developer'),
      environment: { TASK_FLAG: 'on', HOME_HINT: null },
    }))

    const result = await bash!.execute(
      'call',
      { command: 'printf "%s\\n%s\\n" "$PATH" "$TASK_FLAG"; printenv HOME_HINT || echo unset' },
      undefined,
      undefined,
      context as never,
    )
    const [path, flag, hint] = (result.content[0] as { text: string }).text.split('\n')

    expect(path?.startsWith(`${shimDirectory(store)}:`)).toBe(true)
    expect(flag).toBe('on')
    expect(hint).toBe('unset')
  })
})
