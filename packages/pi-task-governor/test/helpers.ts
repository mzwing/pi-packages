import type { SpecInput } from '../src/task.js'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
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
