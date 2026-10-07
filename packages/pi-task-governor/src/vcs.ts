import { execFile } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// The user's own jj config applies; these keep its output machine-readable whatever that config says.
const BASE_ARGUMENTS = ['--no-pager', '--color=never', '--config', 'ui.diff-formatter=:git']
const OPERATION_ID = /--no-integrate-operation was requested: ([0-9a-f]+)/
// Another task can move the bookmark between this task's rebase and its bookmark update.
const MERGE_ATTEMPTS = 3

export interface Workspace {
  /** jj's name for it; `<name>@-` is the task's head. */
  name: string
  path: string
}

/** `onto` is the bookmark commit a merge that did not land took in, where the task's own changes now start. */
export type MergeResult =
  | { kind: 'merged'; commit: string }
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

/** Repository-wide commands never snapshot the user's own working copy in the main workspace. */
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

/** Checking out the new working copy is part of adding a workspace, so this one command snapshots the main one. */
export async function addWorkspace(repo: string, workspace: Workspace, commit: string): Promise<void> {
  // jj creates the workspace directory itself but not its parent.
  mkdirSync(dirname(workspace.path), { recursive: true })
  await jj(repo, ['-R', repo, 'workspace', 'add', '--name', workspace.name, '-r', commit, workspace.path])
}

export async function removeWorkspace(repo: string, workspace: Workspace): Promise<void> {
  await inRepo(repo, ['workspace', 'forget', workspace.name])
  rmSync(workspace.path, { recursive: true, force: true })
}

/** Snapshots the workspace; true when its working copy holds no changes. */
export async function isClean(workspace: Workspace): Promise<boolean> {
  const { stdout } = await jj(workspace.path, ['log', '--no-graph', '-r', '@', '-T', 'empty'])

  return stdout.trim() === 'true'
}

/** Commits whatever the working copy holds; false when it held nothing. */
export async function commitWorkingCopy(workspace: Workspace, message: string): Promise<boolean> {
  if (await isClean(workspace)) {
    return false
  }
  await jj(workspace.path, ['commit', '-m', message])

  return true
}

/** Drops working-copy changes, such as files a check rewrote. */
export async function restoreWorkingCopy(workspace: Workspace): Promise<void> {
  await jj(workspace.path, ['restore'])
}

export async function diff(repo: string, from: string, to: string, stat: boolean): Promise<string> {
  const { stdout } = await inRepo(repo, ['diff', stat ? '--stat' : '--git', '--from', from, '--to', to])

  return stdout
}

/**
 * Merges a signed-off task into its bookmark, which only ever moves forward. A head that does not descend from the
 * bookmark is rebased onto it first, as a dry run: on conflict the rebase is dropped and the workspace gets a merge
 * commit for the task's executor to resolve; otherwise it is kept, and `verify` re-runs the checks on the new head.
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
    // Pinned, so the dry run, its conflict check and the merge commit all see the same bookmark commit.
    const onto = await bookmarkCommit(repo, bookmark)
    if (!(await isAncestor(repo, onto, head))) {
      const { stderr } = await inRepo(repo, ['--no-integrate-operation', 'rebase', '-b', head, '-o', onto])
      const operation = OPERATION_ID.exec(stderr)?.[1]
      if (operation === undefined) {
        throw new Error(`jj did not report the rebase operation: ${stderr.trim()}`)
      }
      const { stdout: conflicts } = await inRepo(repo, [
        '--at-op',
        operation,
        'log',
        '--no-graph',
        '-r',
        `conflicts() & (${onto}..${workspace.name}@-)`,
        '-T',
        'commit_id',
      ])
      if (conflicts.trim() !== '') {
        await jj(workspace.path, ['new', `${workspace.name}@-`, onto, '-m', message])

        return { kind: 'conflicted', onto }
      }
      await inRepo(repo, ['op', 'integrate', operation])
      await jj(workspace.path, ['workspace', 'update-stale'])
      const failure = await verify()
      if (failure !== undefined) {
        return { kind: 'failed-checks', detail: failure, onto }
      }
    }
    const target = await headOf(repo, workspace)
    try {
      await inRepo(repo, ['bookmark', 'set', bookmark, '-r', target])

      return { kind: 'merged', commit: target }
    } catch (error) {
      if (attempt === MERGE_ATTEMPTS || (await isAncestor(repo, quote(bookmark), target))) {
        throw error
      }
    }
  }
}
