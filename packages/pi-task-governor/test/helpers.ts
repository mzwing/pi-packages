import type { SpecInput } from '../src/tasks/task.js'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import { storeDirectory, updateState } from '../src/tasks/store.js'
import { beginReview, claimRoot, declareRoot, recordVerdict } from '../src/tasks/task.js'
import { saveEnvironment } from '../src/workspace/env.js'
import { addWorkspace, bookmarkCommit, headOf, saveWorkingCopy } from '../src/workspace/vcs.js'
import { initRepository } from './jj.js'

export interface Workspace {
  root: string
  /** The main workspace of a colocated jj repository whose `main` bookmark holds `shared.txt`. */
  repo: string
  agent: string
}

// Above every platform's pid range, so it can never be a live process.
export const DEAD_PID: number = 2 ** 31 - 1

export const PARSER_SPEC: SpecInput = {
  title: 'Fix the parser',
  problem: 'CRLF input breaks parsing',
  scope: 'Normalise line endings in the tokenizer',
  boundary: 'src/parser only',
  nonGoals: ['Rewriting the grammar'],
  acceptance: [{ statement: 'Tests pass', check: 'pnpm test' }, { statement: 'No API change' }],
}

/** What the scripted model in `fixtures/faux-model.ts` carries out. */
export const ADD_FILE_SPEC: SpecInput = {
  title: 'Add a.txt',
  problem: 'a.txt is missing',
  scope: 'Create a.txt',
  boundary: 'The repository root',
  nonGoals: ['Touching shared.txt'],
  acceptance: [{ statement: 'a.txt exists', check: 'test -f a.txt' }, { statement: 'a.txt says hello' }],
}

/**
 * A throwaway root holding a repository and an agent dir, with `PI_CODING_AGENT_DIR` pointed at the latter and jj
 * kept away from the user's own config and identity.
 */
export function useWorkspace(): Workspace {
  const workspace: Workspace = { root: '', repo: '', agent: '' }
  beforeEach(() => {
    // Under /tmp, so the Unix sockets the hub opens inside the agent dir keep a short path.
    workspace.root = realpathSync(mkdtempSync('/tmp/ptg-'))
    workspace.repo = join(workspace.root, 'repo')
    workspace.agent = join(workspace.root, 'agent')
    const jjConfig = join(workspace.root, 'jj-config.toml')
    writeFileSync(jjConfig, '[user]\nname = "Test"\nemail = "test@example.com"\n')
    vi.stubEnv('JJ_CONFIG', jjConfig)
    vi.stubEnv('PI_CODING_AGENT_DIR', workspace.agent)
    initRepository(workspace.repo)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(workspace.root, { recursive: true, force: true })
  })

  return workspace
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

/**
 * Declares a root task in an initialised store, writes `contents` to `file` in a workspace of its own, and has its
 * reviewer sign that commit off, so it waits for the coordinator's sign-off; its executor is gone.
 */
export async function signedOff(workspace: Workspace, file: string, contents: string): Promise<string> {
  const store = storeDirectory(workspace.repo)
  const id = updateState(store, state => declareRoot(state, PARSER_SPEC, 'main', [], 'boss', 1).id)
  const task = { name: `task-${id}`, path: join(`${workspace.repo}.tasks`, id) }
  const base = await bookmarkCommit(workspace.repo, 'main')
  await addWorkspace(workspace.repo, task, base)
  writeFileSync(join(task.path, file), contents)
  await saveWorkingCopy(workspace.repo, task, base)
  const head = await headOf(workspace.repo, task)
  saveEnvironment(store, id, { changes: {} })
  updateState(store, state => {
    claimRoot(state, id, { sessionId: `executor-${id}`, pid: DEAD_PID, workspace: task, sessions: 0 }, 2)
    state.tasks[id]!.base.commit = base
    beginReview(state, id, `executor-${id}`, head, 3)
    recordVerdict(state, id, {
      reviewer: `reviewer-${id}`,
      commit: head,
      verdict: 'pass',
      evidence: {
        A1: { kind: 'check', command: 'pnpm test', exitCode: 0, output: '', commit: head },
        A2: { kind: 'observation', text: 'No export changed' },
      },
      findings: '',
      at: 4,
    })
  })

  return id
}
