import { execFile } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// The user's own jj config applies; these keep its output machine-readable whatever that config says
const BASE_ARGUMENTS = ['--no-pager', '--color=never', '--config', 'ui.diff-formatter=:git']
// Another task can move the bookmark between this task's rebase and its bookmark update
const MERGE_ATTEMPTS = 3

export interface Workspace {
  /** jj's name for it; `<name>@-` is the task's head */
  name: string
  path: string
}

/** `onto` is the bookmark commit the merge built on, where the task's own changes now start */
export type MergeResult =
  | { kind: 'merged'; commit: string; onto: string }
  | { kind: 'conflicted'; onto: string }
  | { kind: 'failed-checks'; detail: string; onto: string }

async function jj(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync('jj', [...BASE_ARGUMENTS, ...args], { cwd, maxBuffer: 64 * 1024 * 1024 })
  } catch (error) {
    const failure = error as { stderr?: string; message: string }
    const detail = failure.stderr?.trim() ?? ''
    throw new Error(`jj ${args.join(' ')} failed: ${detail === '' ? failure.message : detail}`)
  }
}

/** Repository-wide commands never snapshot the user's own working copy in the main workspace */
async function inRepo(repo: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return jj(repo, ['-R', repo, '--ignore-working-copy', ...args])
}

function quote(bookmark: string): string {
  return JSON.stringify(bookmark)
}

async function resolveCommit(repo: string, revision: string): Promise<string> {
  const { stdout } = await inRepo(repo, ['log', '--no-graph', '-r', `exactly(${revision}, 1)`, '-T', 'commit_id'])

  return stdout.trim()
}

export async function bookmarkCommit(repo: string, bookmark: string): Promise<string> {
  return resolveCommit(repo, quote(bookmark))
}

export async function headOf(repo: string, workspace: Workspace): Promise<string> {
  return resolveCommit(repo, `${workspace.name}@-`)
}

async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  const { stdout } = await inRepo(repo, [
    'log',
    '--no-graph',
    '-r',
    `(${ancestor}) & ::(${descendant})`,
    '-T',
    'commit_id',
  ])

  return stdout.trim() !== ''
}

/** Checking out the new working copy is part of adding a workspace, so this one command snapshots the main one */
export async function addWorkspace(repo: string, workspace: Workspace, commit: string): Promise<void> {
  // jj creates the workspace directory itself but not its parent
  mkdirSync(dirname(workspace.path), { recursive: true })
  // Never a Git worktree, even in a colocated repository: the task environment and the developer prompt count on no .git
  await jj(repo, [
    '-R',
    repo,
    'workspace',
    'add',
    '--no-colocate',
    '--name',
    workspace.name,
    '-r',
    commit,
    workspace.path,
  ])
}

export async function removeWorkspace(repo: string, workspace: Workspace): Promise<void> {
  await inRepo(repo, ['workspace', 'forget', workspace.name])
  rmSync(workspace.path, { recursive: true, force: true })
}

/** Snapshots the workspace; true when its working copy holds no changes */
export async function isClean(workspace: Workspace): Promise<boolean> {
  const { stdout } = await jj(workspace.path, ['log', '--no-graph', '-r', '@', '-T', 'empty'])

  return stdout.trim() === 'true'
}

/**
 * Keeps a task's work as one undescribed commit on `base`: the first change becomes it, later ones fold into it. A
 * clean working copy returns false untouched, since squashing nothing would still rewrite the commit
 */
export async function saveWorkingCopy(repo: string, workspace: Workspace, base: string): Promise<boolean> {
  if (await isClean(workspace)) {
    return false
  }
  await jj(workspace.path, [(await headOf(repo, workspace)) === base ? 'new' : 'squash'])

  return true
}

/** Drops working-copy changes, such as files a check rewrote */
export async function restoreWorkingCopy(workspace: Workspace): Promise<void> {
  await jj(workspace.path, ['restore'])
}

export async function diff(repo: string, from: string, to: string, stat: boolean): Promise<string> {
  const { stdout } = await inRepo(repo, ['diff', stat ? '--stat' : '--git', '--from', from, '--to', to])

  return stdout
}

function lines(stdout: string): string[] {
  return stdout.split('\n').filter(line => line !== '')
}

export async function changedFiles(repo: string, from: string, to: string): Promise<string[]> {
  const { stdout } = await inRepo(repo, ['diff', '--name-only', '--from', from, '--to', to])

  return lines(stdout)
}

/** Those of `commits` that the bookmark took in after `base` */
export async function landedAfter(repo: string, base: string, bookmark: string, commits: string[]): Promise<string[]> {
  if (commits.length === 0) {
    return []
  }
  const { stdout } = await inRepo(repo, [
    'log',
    '--no-graph',
    '-r',
    `(${base}..${quote(bookmark)}) & (${commits.join(' | ')})`,
    '-T',
    'commit_id ++ "\\n"',
  ])

  return lines(stdout)
}

/**
 * Merges a signed-off task into its bookmark, which only ever moves forward, with `message` on its commit. A head that
 * does not descend from the bookmark is rebased onto it first: on conflict the rebase stays for the task's executor to
 * resolve, and otherwise `verify` re-runs the checks on the new head
 */
export async function mergeInto(
  repo: string,
  workspace: Workspace,
  bookmark: string,
  message: string,
  verify: () => Promise<string | undefined>,
): Promise<MergeResult> {
  for (let attempt = 1; ; attempt += 1) {
    const head = await headOf(repo, workspace)
    // Pinned, so the ancestor check, the rebase and the result all name one bookmark commit
    const onto = await bookmarkCommit(repo, bookmark)
    if (!(await isAncestor(repo, onto, head))) {
      await jj(workspace.path, ['rebase', '-b', head, '-o', onto])
      const { stdout: conflicted } = await inRepo(repo, [
        'log',
        '--no-graph',
        '-r',
        `${workspace.name}@-`,
        '-T',
        'conflict',
      ])
      if (conflicted.trim() === 'true') {
        return { kind: 'conflicted', onto }
      }
      const failure = await verify()
      if (failure !== undefined) {
        return { kind: 'failed-checks', detail: failure, onto }
      }
    }
    await jj(workspace.path, ['describe', '-r', `${workspace.name}@-`, '-m', message])
    const target = await headOf(repo, workspace)
    try {
      await inRepo(repo, ['bookmark', 'set', bookmark, '-r', target])

      return { kind: 'merged', commit: target, onto }
    } catch (error) {
      if (attempt === MERGE_ATTEMPTS || (await isAncestor(repo, quote(bookmark), target))) {
        throw error
      }
    }
  }
}
