// Read by `scripts/sync-guardian-policy.ts`, which rewrites the `UPSTREAM_REVISION` literal in place on `--pin`.
export const UPSTREAM_REPO = 'openai/codex'
// Moved here by openai/codex#46026, and by #41477 before that. The commits API does not follow renames, so a
// `--ref` older than the latest move resolves nothing.
export const UPSTREAM_DIRECTORY = 'codex-rs/prompts/templates/guardian'
export const UPSTREAM_FILES = ['policy_template.md', 'policy.md'] as const

/** The newest upstream commit touching `UPSTREAM_FILES` that the adapted text has been reconciled against. */
export const UPSTREAM_REVISION = '26cb4d73e2ce25575644038d7af5beb2440d0ed0'

/** Bumped when the adapted text changes without the upstream revision moving. */
export const PI_ADAPTATION_REVISION = 2
