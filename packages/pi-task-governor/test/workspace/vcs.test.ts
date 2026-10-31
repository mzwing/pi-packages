import type { Workspace } from '../../src/workspace/vcs.js'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  addWorkspace,
  bookmarkCommit,
  changedFiles,
  diff,
  headOf,
  isClean,
  landedAfter,
  mergeInto,
  removeWorkspace,
  saveWorkingCopy,
} from '../../src/workspace/vcs.js'
import { useWorkspace } from '../helpers.js'
import { jj } from '../jj.js'

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

  /** The subject lines of the commits `main` took in after `from`, newest first. */
  function landedSubjects(repo: string, from: string): string[] {
    return jj(repo, 'log', '--no-graph', '-r', `${from}..main`, '-T', 'description.first_line() ++ "\\n"')
      .trim()
      .split('\n')
  }

  it("keeps a task's work in one undescribed commit, saving only what changed", async () => {
    const {
      repo,
      base,
      workspaces: [task],
    } = await setUp('T1')

    expect(existsSync(join(task!.path, '.git'))).toBe(false)
    expect(await saveWorkingCopy(repo, task!, base)).toBe(false)
    edit(task!, 'shared.txt', 'line1\nline2 fixed\nline3\n')
    expect(await saveWorkingCopy(repo, task!, base)).toBe(true)
    edit(task!, 'shared.txt', 'line1\nline2 fixed\nline3 fixed\n')
    expect(await saveWorkingCopy(repo, task!, base)).toBe(true)
    expect(await isClean(task!)).toBe(true)
    const head = await headOf(repo, task!)
    expect(await saveWorkingCopy(repo, task!, base)).toBe(false)

    expect(await headOf(repo, task!)).toBe(head)
    expect(jj(repo, 'log', '--no-graph', '-r', `${base}..${head}`, '-T', 'description ++ "|"')).toBe('|')
    expect(await diff(repo, base, head, true)).toContain('shared.txt')
    expect(await diff(repo, base, head, false)).toContain('+line3 fixed')
  })

  it('lists the files a change touches, and which commits a bookmark took in after a base', async () => {
    const {
      repo,
      base,
      workspaces: [first, second],
    } = await setUp('T1', 'T2')
    edit(first!, 'a.txt', 'a\n')
    edit(first!, 'shared.txt', 'line1\nline2 by T1\nline3\n')
    await saveWorkingCopy(repo, first!, base)
    edit(second!, 'b.txt', 'b\n')
    await saveWorkingCopy(repo, second!, base)
    const [landed, open] = [await headOf(repo, first!), await headOf(repo, second!)]
    jj(repo, 'bookmark', 'set', 'main', '-r', landed)

    expect(await changedFiles(repo, base, landed)).toEqual(['a.txt', 'shared.txt'])
    expect(await landedAfter(repo, base, 'main', [landed, open])).toEqual([landed])
    expect(await landedAfter(repo, landed, 'main', [landed])).toEqual([])
    expect(await landedAfter(repo, base, 'main', [])).toEqual([])
  })

  it('lands the commit of a head that already descends from the bookmark with the message it is given', async () => {
    const {
      repo,
      base,
      workspaces: [task],
    } = await setUp('T1')
    edit(task!, 'a.txt', 'a\n')
    await saveWorkingCopy(repo, task!, base)
    const verify = vi.fn(async () => undefined)

    const result = await mergeInto(repo, task!, 'main', 'feat: add `a.txt`\n\nThe parser reads it.', verify)

    expect(result).toEqual({ kind: 'merged', commit: await bookmarkCommit(repo, 'main'), onto: base })
    expect(jj(repo, 'log', '--no-graph', '-r', `${base}..main`, '-T', 'description')).toBe(
      'feat: add `a.txt`\n\nThe parser reads it.\n',
    )
    expect(await changedFiles(repo, base, 'main')).toEqual(['a.txt'])
    expect(verify).not.toHaveBeenCalled()
  })

  it('rebases a head the bookmark has moved past, re-checks it, then lands it', async () => {
    const {
      repo,
      base,
      workspaces: [first, second],
    } = await setUp('T1', 'T2')
    edit(first!, 'a.txt', 'a\n')
    await saveWorkingCopy(repo, first!, base)
    await mergeInto(repo, first!, 'main', 'feat: add a', async () => undefined)
    edit(second!, 'b.txt', 'b\n')
    await saveWorkingCopy(repo, second!, base)
    const merged = await bookmarkCommit(repo, 'main')

    const verify = vi.fn(async () => (existsSync(join(second!.path, 'a.txt')) ? undefined : 'a.txt missing'))
    const result = await mergeInto(repo, second!, 'main', 'feat: add b', verify)

    expect(result).toEqual({ kind: 'merged', commit: await bookmarkCommit(repo, 'main'), onto: merged })
    expect(verify).toHaveBeenCalledOnce()
    expect(landedSubjects(repo, base)).toEqual(['feat: add b', 'feat: add a'])
  })

  it('leaves the bookmark alone when the rebased head fails its checks', async () => {
    const {
      repo,
      base,
      workspaces: [first, second],
    } = await setUp('T1', 'T2')
    edit(first!, 'a.txt', 'a\n')
    await saveWorkingCopy(repo, first!, base)
    await mergeInto(repo, first!, 'main', 'feat: add a', async () => undefined)
    edit(second!, 'b.txt', 'b\n')
    await saveWorkingCopy(repo, second!, base)
    const merged = await bookmarkCommit(repo, 'main')

    expect(await mergeInto(repo, second!, 'main', 'feat: add b', async () => 'tests fail')).toEqual({
      kind: 'failed-checks',
      detail: 'tests fail',
      onto: merged,
    })
    expect(await bookmarkCommit(repo, 'main')).toBe(merged)
    expect(merged).not.toBe(base)
  })

  it('leaves a conflicting rebase in the workspace for the later task to resolve, then lands the resolution', async () => {
    const {
      repo,
      base,
      workspaces: [first, second],
    } = await setUp('T1', 'T2')
    edit(first!, 'shared.txt', 'line1\nline2 by T1\nline3\n')
    await saveWorkingCopy(repo, first!, base)
    await mergeInto(repo, first!, 'main', 'fix: reword line 2', async () => undefined)
    edit(second!, 'shared.txt', 'line1\nline2 by T2\nline3\n')
    await saveWorkingCopy(repo, second!, base)
    const merged = await bookmarkCommit(repo, 'main')

    expect(await mergeInto(repo, second!, 'main', 'fix: credit line 2', async () => undefined)).toEqual({
      kind: 'conflicted',
      onto: merged,
    })
    expect(await bookmarkCommit(repo, 'main')).toBe(merged)
    expect(readFileSync(join(second!.path, 'shared.txt'), 'utf8')).toContain('<<<<<<<')
    expect(await changedFiles(repo, merged, await headOf(repo, second!))).toEqual(['shared.txt'])

    edit(second!, 'shared.txt', 'line1\nline2 by T1 and T2\nline3\n')
    await saveWorkingCopy(repo, second!, merged)
    const verify = vi.fn(async () => undefined)
    const result = await mergeInto(repo, second!, 'main', 'fix: credit line 2', verify)

    expect(result).toEqual({ kind: 'merged', commit: await bookmarkCommit(repo, 'main'), onto: merged })
    expect(verify).not.toHaveBeenCalled()
    expect(landedSubjects(repo, merged)).toEqual(['fix: credit line 2'])
    expect(jj(repo, 'file', 'show', '-r', 'main', 'shared.txt')).toBe('line1\nline2 by T1 and T2\nline3\n')
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
