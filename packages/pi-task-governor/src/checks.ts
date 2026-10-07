import type { Runtime } from './runtime.js'
import type { CheckEvidence, Criterion } from './task.js'
import type { Workspace } from './vcs.js'
import { execFile } from 'node:child_process'
import process from 'node:process'
import { promisify } from 'node:util'
import { applyChanges } from './env.js'
import { shimDirectory } from './guard.js'
import { isClean, restoreWorkingCopy } from './vcs.js'

const execFileAsync = promisify(execFile)
const CHECK_TIMEOUT_MS = 30 * 60_000
const OUTPUT_TAIL = 4_000

/**
 * Runs a criterion's check in the workspace, inside the task's environment and behind the git, jj and pi shims. A
 * check that leaves changes in the working copy fails, and its changes are dropped: evidence must not alter the work.
 */
export async function runCheck(
  runtime: Runtime,
  workspace: Workspace,
  criterion: Criterion,
  commit: string,
): Promise<CheckEvidence> {
  const command = criterion.check!
  const env = applyChanges(process.env, runtime.environment)
  env['PATH'] = `${shimDirectory(runtime.store)}:${env['PATH'] ?? ''}`
  let exitCode = 0
  let output: string
  try {
    const result = await execFileAsync('sh', ['-c', command], {
      cwd: workspace.path,
      env,
      timeout: CHECK_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    })
    output = `${result.stdout}${result.stderr}`
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string; message: string }
    exitCode = typeof failure.code === 'number' ? failure.code : 1
    output = `${failure.stdout ?? ''}${failure.stderr ?? ''}${failure.stdout === undefined ? failure.message : ''}`
  }
  if (!(await isClean(workspace))) {
    await restoreWorkingCopy(workspace)
    exitCode = exitCode === 0 ? 1 : exitCode
    output += '\n[pi-task-governor] The check changed tracked files; they were restored and the check counts as failed.'
  }

  return { kind: 'check', command, exitCode, output: output.slice(-OUTPUT_TAIL), commit }
}

/** Every check of a task on its current head, for re-checking a head that a rebase changed. */
export async function failedChecks(
  runtime: Runtime,
  workspace: Workspace,
  criteria: Criterion[],
  commit: string,
): Promise<string | undefined> {
  const failures: string[] = []
  for (const criterion of criteria.filter(item => item.check !== undefined)) {
    const evidence = await runCheck(runtime, workspace, criterion, commit)
    if (evidence.exitCode !== 0) {
      failures.push(
        `${criterion.id} (\`${evidence.command}\`) exited ${evidence.exitCode}: ${evidence.output.slice(-500)}`,
      )
    }
  }

  return failures.length === 0 ? undefined : failures.join('\n')
}
