import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  applyChanges,
  flakeChanges,
  loadEnvironment,
  prepareEnvironment,
  saveEnvironment,
} from '../../src/workspace/env.js'
import { useWorkspace } from '../helpers.js'

describe('task environment', () => {
  const workspace = useWorkspace()

  function taskDirectory(files: Record<string, string>): string {
    const directory = join(workspace.root, 'task')
    mkdirSync(directory, { recursive: true })
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(directory, name), contents)
    }
    // direnv records allowed files here; keep the user's own list out of it
    vi.stubEnv('XDG_DATA_HOME', join(workspace.root, 'xdg'))

    return directory
  }

  it('applies changes over an inherited environment, unsetting null ones', () => {
    expect(applyChanges({ KEEP: '1', DROP: '2', SET: 'old' }, { DROP: null, SET: 'new', ADD: '3' })).toEqual({
      KEEP: '1',
      SET: 'new',
      ADD: '3',
    })
  })

  it("takes a flake dev shell's exported variables, its PATH ahead of the inherited one", () => {
    const output = JSON.stringify({
      bashFunctions: {},
      variables: {
        PATH: { type: 'exported', value: '/nix/store/hello/bin' },
        FOO: { type: 'exported', value: 'bar' },
        shellHook: { type: 'var', value: 'echo hi' },
        outputs: { type: 'array', value: ['out'] },
      },
    })

    expect(flakeChanges(output, '/usr/bin')).toEqual({ PATH: '/nix/store/hello/bin:/usr/bin', FOO: 'bar' })
  })

  it('captures an .envrc through direnv with a TMPDIR of the task, and runs setup inside it', async () => {
    const directory = taskDirectory({ '.envrc': 'export TASK_FLAG=on\n' })

    const environment = await prepareEnvironment(directory, 'auto', [
      'printf "%s %s" "$TASK_FLAG" "$TMPDIR" > setup.out',
    ])

    expect(environment.changes).toMatchObject({ TASK_FLAG: 'on', TMPDIR: `${directory}.tmp` })
    expect(existsSync(`${directory}.tmp`)).toBe(true)
    expect(environment.storeCopy).toBeUndefined()
    expect(readFileSync(join(directory, 'setup.out'), 'utf8')).toBe(`on ${directory}.tmp`)
    saveEnvironment(workspace.root, 'T1', environment)
    expect(loadEnvironment(workspace.root, 'T1')).toEqual(environment)
  })

  it('needs only its TMPDIR without an .envrc or flake, and reports a failing setup with its output', async () => {
    const directory = taskDirectory({})

    expect(await prepareEnvironment(directory, 'auto', [])).toEqual({
      changes: { TMPDIR: `${directory}.tmp` },
      storeCopy: undefined,
    })
    await expect(prepareEnvironment(directory, 'none', ['echo "lockfile is stale" >&2; exit 1'])).rejects.toThrow(
      'Setup command `echo "lockfile is stale" >&2; exit 1` failed: lockfile is stale',
    )
  })
})
