/**
 * Report upstream Codex Guardian policy changes since the pinned revision.
 *
 *   node --experimental-strip-types scripts/sync-guardian-policy.ts [--ref <ref>] [--pin]
 *
 * The bundled policy in `src/policy.ts` is a Pi adaptation, not a copy — Pi's
 * reviewer has no tools and a different evidence-provenance model, so upstream
 * wording cannot be dropped in mechanically. This script therefore never edits
 * the policy text. It answers one question: has upstream moved, and which
 * commits do I need to read?
 *
 * Default run reports only, exiting non-zero when upstream moved so CI can fail.
 * `--pin` records the new revision in `src/upstream.ts` — run it as the final
 * step *after* porting the changes by hand, never before: POLICY_REVISION goes
 * into the permission review log, so a pin that outruns the text is a false
 * audit record.
 *
 * Set `GITHUB_TOKEN` to lift the 60-requests/hour anonymous rate limit.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { UPSTREAM_DIRECTORY, UPSTREAM_FILES, UPSTREAM_REPO, UPSTREAM_REVISION } from '../src/upstream.ts'

interface Commit {
  sha: string
  committedAt: string
  summary: string
}

const MANIFEST_PATH = fileURLToPath(new URL('../src/upstream.ts', import.meta.url))
const REVISION_PATTERN = /(export const UPSTREAM_REVISION = ')[\da-f]{40}(')/

const { values } = parseArgs({
  // Drop the separator pnpm forwards on `pnpm sync:policy -- --pin`; parseArgs
  // would otherwise treat everything after it as positional and ignore the flag.
  args: process.argv.slice(2).filter(argument => argument !== '--'),
  options: {
    ref: { type: 'string', default: 'main' },
    pin: { type: 'boolean', default: false },
  },
})

const token = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN']
const headers: Record<string, string> = {
  accept: 'application/vnd.github+json',
  ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
}

async function api(path: string): Promise<unknown> {
  const url = `https://api.github.com/repos/${UPSTREAM_REPO}/${path}`
  const response = await fetch(url, { headers })
  if (!response.ok) {
    const hint = response.status === 403 && token === undefined ? ' (set GITHUB_TOKEN to raise the rate limit)' : ''
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}${hint}`)
  }
  return response.json()
}

interface RawCommit {
  sha?: string
  commit?: { committer?: { date?: string }; message?: string }
}

function toCommit(raw: RawCommit): Commit | undefined {
  if (raw.sha === undefined) {
    return undefined
  }
  return {
    sha: raw.sha,
    committedAt: raw.commit?.committer?.date ?? '',
    summary: (raw.commit?.message ?? '').split('\n')[0] ?? '',
  }
}

function filePath(file: string): string {
  return `${UPSTREAM_DIRECTORY}/${file}`
}

/** Commits touching `file` at or below `ref`, newest first. */
async function history(file: string, ref: string, since?: string): Promise<Commit[]> {
  const query = new URLSearchParams({ path: filePath(file), sha: ref, per_page: '20' })
  if (since !== undefined) {
    query.set('since', since)
  }
  const raw = (await api(`commits?${query.toString()}`)) as RawCommit[]
  return raw.map(toCommit).filter((commit): commit is Commit => commit !== undefined)
}

const pinned = toCommit((await api(`commits/${UPSTREAM_REVISION}`)) as RawCommit)
if (pinned === undefined) {
  throw new Error(`pinned revision ${UPSTREAM_REVISION} not found in ${UPSTREAM_REPO}`)
}

// Each tracked file moves independently, so the revision to pin is the newest
// commit across all of them — the same thing POLICY_REVISION claims.
const heads = await Promise.all(UPSTREAM_FILES.map(async file => history(file, values.ref)))
const newest = heads
  .flatMap(commits => commits.slice(0, 1))
  .reduce((left, right) => (right.committedAt > left.committedAt ? right : left))

console.log(`upstream   ${UPSTREAM_REPO}/${UPSTREAM_DIRECTORY} @ ${values.ref}`)
console.log(`pinned     ${UPSTREAM_REVISION}  (${pinned.committedAt})`)

if (newest.sha === UPSTREAM_REVISION) {
  console.log(`resolved   ${newest.sha}  (unchanged)\n\nUpstream has not moved. Nothing to port.`)
  process.exit(0)
}

console.log(`resolved   ${newest.sha}  (${newest.committedAt})\n`)

// `since` is inclusive, so drop the pinned commit itself from each list.
const landed = await Promise.all(
  UPSTREAM_FILES.map(async file => ({
    file,
    commits: (await history(file, values.ref, pinned.committedAt)).filter(commit => commit.sha !== UPSTREAM_REVISION),
  })),
)

for (const { file, commits } of landed) {
  if (commits.length === 0) {
    console.log(`${file}: unchanged`)
    continue
  }
  console.log(`${file}: ${commits.length} new commit${commits.length === 1 ? '' : 's'}`)
  for (const commit of commits) {
    console.log(`  ${commit.sha.slice(0, 12)}  ${commit.summary}`)
    console.log(`    https://github.com/${UPSTREAM_REPO}/commit/${commit.sha}`)
  }
  console.log(`  full history: https://github.com/${UPSTREAM_REPO}/commits/${values.ref}/${filePath(file)}`)
}

if (!values.pin) {
  console.error(
    '\nRead the commits above, port what applies into the adapted text in src/policy.ts,' +
      '\nthen re-run with --pin to record the new revision.',
  )
  process.exit(1)
}

writeFileSync(MANIFEST_PATH, readFileSync(MANIFEST_PATH, 'utf8').replace(REVISION_PATTERN, `$1${newest.sha}$2`))
console.log(`\nPinned ${newest.sha} in src/upstream.ts.`)
console.log('Bump PI_ADAPTATION_REVISION too if you reworded anything Pi-specific.')
