import type { Workspace } from '../src/vcs.js'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  addWorkspace,
  bookmarkCommit,
  commitWorkingCopy,
  diff,
  headOf,
  isClean,
  mergeInto,
  removeWorkspace,
} from '../src/vcs.js'
import { useWorkspace } from './helpers.js'
import { jj } from './jj.js'

describe('jj controller', () => {
  const root = useWorkspace()

  async function setUp(...names: string[]): Promise<{ repo: string; base: string; workspaces: Workspace[] }> {
    const repo = root.repo
    const base = await bookmarkCommit(repo, 'main')
    const workspaces = names.map(name => ({ name: `task-${name}`, path: join(root.root, 'repo.tasks', name) }))
    for (const workspace of workspaces) {
      await addWorkspace(repo, workspace, base)
    }

    return { repo, base, workspaces }
  }

  function edit(workspace: Workspace, file: string, contents: string): void {
    writeFileSync(join(workspace.path, file), contents)
  }

  it('commits a workspace only when it changed, and diffs the task against its base', async () => {
    const {
      repo,
      base,
      workspaces: [task],
    } = await setUp('T1')

    expect(existsSync(join(task!.path, '.git'))).toBe(false)
    expect(await commitWorkingCopy(task!, 'T1: nothing')).toBe(false)
    edit(task!, 'shared.txt', 'line1\nline2 fixed\nline3\n')
    expect(await commitWorkingCopy(task!, 'T1: fix line 2')).toBe(true)
    expect(await isClean(task!)).toBe(true)

    expect(await diff(repo, base, await headOf(repo, task!), true)).toContain('shared.txt')
    expect(await diff(repo, base, await headOf(repo, task!), false)).toContain('+line2 fixed')
  })

  it('fast-forwards the bookmark to a head that already descends from it', async () => {
    const {
      repo,
      workspaces: [task],
    } = await setUp('T1')
    edit(task!, 'a.txt', 'a\n')
    await commitWorkingCopy(task!, 'T1: add a')
    const verify = vi.fn(async () => undefined)

    const result = await mergeInto(repo, task!, 'main', 'T1: merge main', verify)

    expect(result).toEqual({ kind: 'merged', commit: await headOf(repo, task!) })
    expect(await bookmarkCommit(repo, 'main')).toBe(await headOf(repo, task!))
    expect(verify).not.toHaveBeenCalled()
  })

  it('rebases a head the bookmark has moved past, re-checks it, then moves the bookmark forward', async () => {
    const {
      repo,
      workspaces: [first, second],
    } = await setUp('T1', 'T2')
    edit(first!, 'a.txt', 'a\n')
    await commitWorkingCopy(first!, 'T1: add a')
    await mergeInto(repo, first!, 'main', 'T1: merge main', async () => undefined)
    edit(second!, 'b.txt', 'b\n')
    await commitWorkingCopy(second!, 'T2: add b')

    const verify = vi.fn(async () => (existsSync(join(second!.path, 'a.txt')) ? undefined : 'a.txt missing'))
    const result = await mergeInto(repo, second!, 'main', 'T2: merge main', verify)

    expect(result).toEqual({ kind: 'merged', commit: await bookmarkCommit(repo, 'main') })
    expect(verify).toHaveBeenCalledOnce()
    expect(jj(second!.path, 'log', '--no-graph', '-r', '::main', '-T', 'description.first_line() ++ "\\n"')).toContain(
      'T1: add a',
    )
  })

  it('leaves the bookmark alone when the rebased head fails its checks', async () => {
    const {
      repo,
      base,
      workspaces: [first, second],
    } = await setUp('T1', 'T2')
    edit(first!, 'a.txt', 'a\n')
    await commitWorkingCopy(first!, 'T1: add a')
    await mergeInto(repo, first!, 'main', 'T1: merge main', async () => undefined)
    edit(second!, 'b.txt', 'b\n')
    await commitWorkingCopy(second!, 'T2: add b')
    const merged = await bookmarkCommit(repo, 'main')

    expect(await mergeInto(repo, second!, 'main', 'T2: merge main', async () => 'tests fail')).toEqual({
      kind: 'failed-checks',
      detail: 'tests fail',
      onto: merged,
    })
    expect(await bookmarkCommit(repo, 'main')).toBe(merged)
    expect(merged).not.toBe(base)
  })

  it('turns a conflicting rebase into a merge commit for the later task to resolve', async () => {
    const {
      repo,
      workspaces: [first, second],
    } = await setUp('T1', 'T2')
    edit(first!, 'shared.txt', 'line1\nline2 by T1\nline3\n')
    await commitWorkingCopy(first!, 'T1: edit line 2')
    await mergeInto(repo, first!, 'main', 'T1: merge main', async () => undefined)
    edit(second!, 'shared.txt', 'line1\nline2 by T2\nline3\n')
    await commitWorkingCopy(second!, 'T2: edit line 2')
    const merged = await bookmarkCommit(repo, 'main')

    expect(await mergeInto(repo, second!, 'main', 'T2: merge main', async () => undefined)).toEqual({
      kind: 'conflicted',
      onto: merged,
    })
    expect(await bookmarkCommit(repo, 'main')).toBe(merged)
    expect(readFileSync(join(second!.path, 'shared.txt'), 'utf8')).toContain('<<<<<<<')

    edit(second!, 'shared.txt', 'line1\nline2 by T1 and T2\nline3\n')
    await commitWorkingCopy(second!, 'T2: merge main')
    const result = await mergeInto(repo, second!, 'main', 'T2: merge main', async () => undefined)

    expect(result).toEqual({ kind: 'merged', commit: await headOf(repo, second!) })
  })

  it('forgets a workspace and deletes its directory', async () => {
    const {
      repo,
      workspaces: [task],
    } = await setUp('T1')

    await removeWorkspace(repo, task!)

    expect(existsSync(task!.path)).toBe(false)
    expect(jj(repo, 'workspace', 'list')).not.toContain('task-T1')
  })
})
