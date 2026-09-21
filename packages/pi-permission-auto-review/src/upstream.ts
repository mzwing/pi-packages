/**
 * The upstream OpenAI Codex Guardian sources the bundled policy adapts.
 *
 * `scripts/sync-guardian-policy.ts` reads this manifest to know which files to
 * watch, and rewrites {@link UPSTREAM_REVISION} on `--pin`. Keep the revision
 * literal on one line so that rewrite stays unambiguous.
 */
export const UPSTREAM_REPO = 'openai/codex'
// Moved out of `codex-rs/core/assets/guardian` by openai/codex#46026, and out of
// `codex-rs/core/src/guardian` by #41477 before that. The GitHub commits API does
// not follow renames, so history before the latest move is only reachable under
// the old paths — `--ref` older than it resolves nothing here.
export const UPSTREAM_DIRECTORY = 'codex-rs/prompts/templates/guardian'
export const UPSTREAM_FILES = ['policy_template.md', 'policy.md'] as const

/** Newest upstream commit touching {@link UPSTREAM_FILES}. */
export const UPSTREAM_REVISION = 'a8c36ca6d265800c1b2c67d19d3583e23dee8382'

/**
 * Revision of Pi's own adaptation layer, bumped whenever the adapted policy text
 * changes without the upstream revision moving.
 */
export const PI_ADAPTATION_REVISION = 1
