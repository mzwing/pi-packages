/**
 * The upstream OpenAI Codex Guardian sources the bundled policy adapts.
 *
 * `scripts/sync-guardian-policy.ts` reads this manifest to know which files to
 * watch, and rewrites {@link UPSTREAM_REVISION} on `--pin`. Keep the revision
 * literal on one line so that rewrite stays unambiguous.
 */
export const UPSTREAM_REPO = 'openai/codex'
export const UPSTREAM_DIRECTORY = 'codex-rs/core/src/guardian'
export const UPSTREAM_FILES = ['policy_template.md', 'policy.md'] as const

/** Newest upstream commit touching {@link UPSTREAM_FILES}. */
export const UPSTREAM_REVISION = 'c4f42d161ae44a8d696ee9fb595709661979d187'

/**
 * Revision of Pi's own adaptation layer, bumped whenever the adapted policy text
 * changes without the upstream revision moving.
 */
export const PI_ADAPTATION_REVISION = 1
