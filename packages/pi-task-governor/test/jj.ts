import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Runs jj like the controller does, for setting a scene up. */
export function jj(cwd: string, ...args: string[]): string {
  return execFileSync('jj', ['--no-pager', '--color=never', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' })
}

/** A colocated repository whose `main` bookmark holds one commit with `shared.txt`. */
export function initRepository(repo: string): void {
  mkdirSync(repo, { recursive: true })
  jj(repo, 'git', 'init', '--colocate')
  writeFileSync(join(repo, 'shared.txt'), 'line1\nline2\nline3\n')
  jj(repo, 'commit', '-m', 'init')
  jj(repo, 'bookmark', 'create', 'main', '-r', '@-')
}
