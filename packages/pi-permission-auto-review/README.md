# @mzwing/pi-permission-auto-review

[![npm version](https://img.shields.io/npm/v/@mzwing/pi-permission-auto-review?style=flat&logo=npm&logoColor=white)](https://www.npmjs.com/package/@mzwing/pi-permission-auto-review) [![CI](https://img.shields.io/github/actions/workflow/status/mzwing/pi-packages/release.yml?style=flat&logo=github&label=CI)](https://github.com/mzwing/pi-packages/actions/workflows/release.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat)](https://opensource.org/licenses/MIT) [![TypeScript](https://img.shields.io/badge/TypeScript-7.x-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Pi Package](https://img.shields.io/badge/Pi-Package-6366F1?style=flat)](https://github.com/earendil-works/pi)

A [Pi](https://github.com/earendil-works/pi) extension that adds Codex-style automatic permission reviews to [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system).

## Differences between `@gotgenes/pi-permission-model-judge`

[@gotgenes/pi-permission-model-judge](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-model-judge) is a general-purpose model-based authorizer that can be used to evaluate any permission request.

Ours is mostly specialized for OpenAI's `codex-auto-review` model, which is trained to evaluate permission requests in the context of a coding assistant. Our extension aims at providing Codex-style automatic permission reviews for Pi's coding agent.

The bundled baseline is a Pi-specific adaptation of OpenAI Codex Guardian's [`policy_template.md`](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/core/assets/guardian/policy_template.md) and [`policy.md`](https://github.com/openai/codex/blob/6478a751fde8884b2fdc76486fe23175a8e795d4/codex-rs/core/assets/guardian/policy.md) at revision [`6478a751fde8884b2fdc76486fe23175a8e795d4`](https://github.com/openai/codex/commit/6478a751fde8884b2fdc76486fe23175a8e795d4). It is bundled at build time; the extension never fetches policy text while reviewing an action.

Upstream's `Execution Environment` section and its MCP `connected_account_email` rule are deliberately left out: both describe Codex's sandbox and tool surface, which Pi's tool-free reviewer does not have. Upstream's `node_repl_policy.md` is likewise out of scope — it governs `node_repl` / `cua_repl` computer-use tools that Pi does not expose.

### Updating the bundled policy

`src/upstream.ts` records which Codex files the adaptation tracks and the revision it was last reconciled against. `pnpm sync:policy` reports whether upstream has moved since:

```bash
pnpm sync:policy                # report only; exits non-zero when upstream moved
pnpm sync:policy --ref v1.2.3   # resolve against a tag, branch, or commit
pnpm sync:policy --pin          # record the new revision, once you have ported it
```

A run that finds movement lists every commit touching the tracked files since the pinned revision, with links. Port what applies into `src/policy.ts` by hand — the adapted text is a rewrite, not a copy, because Pi's reviewer has no tools and reads a different evidence-provenance model, so upstream wording cannot be dropped in mechanically.

Only re-run with `--pin` once that porting is done. `POLICY_REVISION` is written to the permission review log, so a pin that outruns the text would be a false audit record. Bump `PI_ADAPTATION_REVISION` as well when you reword anything Pi-specific. Set `GITHUB_TOKEN` to lift GitHub's anonymous rate limit.

## Install

```bash
pi install npm:@gotgenes/pi-permission-system # dependency
pi install npm:@mzwing/pi-permission-auto-review
```

Pi 0.84.2+ (0.84.x and 0.85.x) and `@gotgenes/pi-permission-system` 27.x, 28.x, or 29.x are required.

The authorizer registers itself against the service keyed by its own session id, so a subagent's reviewer lands in the node whose gates actually read it.

## Enable

Add `"auto-review"` to pi-permission-system's config:

```json
{
  "authorizerChain": ["auto-review"]
}
```

The config is normally located at `~/.pi/agent/extensions/pi-permission-system/config.json`.

Extension config can be omitted. The defaults are:

```json
{
  "provider": "openai-codex",
  "model": "codex-auto-review",
  "reasoning": "low",
  "timeoutMs": 90000,
  "includeBaselinePolicy": true
}
```

`codex-auto-review` is an official hidden model. The extension derives it from Pi's `openai-codex` provider and reuses the existing Codex login.

## Configuration

| Scope   | Path                                                           |
| ------- | -------------------------------------------------------------- |
| Global  | `~/.pi/agent/extensions/pi-permission-auto-review/config.json` |
| Project | `<cwd>/.pi/extensions/pi-permission-auto-review/config.json`   |

Project fields override global fields. `PI_CODING_AGENT_DIR` replaces `~/.pi/agent` when set.

| Field                   | Default             | Description                                  |
| ----------------------- | ------------------- | -------------------------------------------- |
| `provider`              | `openai-codex`      | Pi model-registry provider id                |
| `model`                 | `codex-auto-review` | Model id within the selected provider        |
| `reasoning`             | `low`               | Reasoning level for reviewer calls           |
| `timeoutMs`             | `90000`             | Total budget across all retry attempts       |
| `includeBaselinePolicy` | `true`              | Include the built-in Codex-style risk policy |
| `additionalPolicy`      | omitted             | Trusted operator policy appended to it       |

See the [example config](config/config.example.json) and bundled [JSON Schema](schemas/config.schema.json). Unknown or invalid fields disable automatic decisions and fall through to the normal prompt.

Use `/permission-auto-review` in Pi's interactive TUI to edit and apply global or project config without reloading the session. Available subcommands:

```text
/permission-auto-review show
/permission-auto-review path
/permission-auto-review reset [global|project]
/permission-auto-review help
```

Custom providers and models must be defined in Pi's `~/.pi/agent/models.json`, then selected with this extension's `provider` and `model` fields. To replace the built-in risk policy completely, set `includeBaselinePolicy` to `false` and provide a non-empty `additionalPolicy`.

## Behavior and Limits

### Authorization evidence

The reviewer reads the current session's complete active branch with `SessionManager.getBranch()`, rather than only the post-compaction model context. This keeps original user authorization available after compaction without mixing in abandoned branches.

Only these transcript records can establish authorization:

- Pi session user-role messages (`source: "user"`);
- completed, non-cancelled responses to recognized `ask_user_question` and `plan_mode_question` calls (`source: "user_interaction"`).

Pi does not persist the original `input` event source on user-role messages, so `source: "user"` is a trust boundary provided by the Pi runtime rather than cryptographic proof of keyboard input. Trusted extensions can intentionally create such messages with `sendUserMessage()`; as with the rest of Pi's extension model, only trusted extension code should be installed.

Structured question responses are accepted only when the non-error result matches a preceding recognized tool call and are rebuilt from `details.answers` data. Free-form tool-result text is never promoted to user evidence. Assistant messages, ordinary tool calls/results, custom messages, and compaction/branch summaries remain untrusted even if their text claims to be user content.

Transcript rendering uses separate 10k-token message and tool budgets with per-entry truncation. The first and latest trusted records are retained first, then other trusted records from newest to oldest. The 40-entry recency cap applies only to assistant/tool evidence, so later tool activity cannot evict an already selected user authorization. Truncation indicates missing information; it does not itself raise intrinsic action risk.

### Permission boundaries

- Model, authentication, timeout, provider, or response-format failures defer to the normal human prompt.
- Unexpected internal review failures also defer to the human prompt instead of escaping into the permission gate.
- Three consecutive denials, or ten denials in the latest fifty reviews, open a circuit breaker until the next Pi turn.
- pi-permission-system's delegation envelope prevents authorizers from auto-approving `path` and `external_directory` requests. An auto-review `allow` for those surfaces is deliberately downgraded to the normal human prompt; this extension does not bypass that boundary.

### Diagnostics

Each `auto_review.decision` emitted after transcript construction adds content-free context diagnostics (configuration failures that defer before a review do not have transcript diagnostics):

- `policyRevision`
- `contextSource` (`active-branch`)
- `transcriptEntriesRetained`
- `transcriptEntriesOmitted`
- `transcriptEntriesTruncated`
- `directUserEntriesRetained` / `directUserEntriesOmitted` / `directUserEntriesTruncated`
- `userInteractionEntriesRetained` / `userInteractionEntriesOmitted` / `userInteractionEntriesTruncated`
- `latestTrustedEntryRetained`

These fields distinguish missing or truncated authorization evidence from a model decision made after receiving trusted evidence. Transcript text and model rationale are not persisted. The records are written through pi-permission-system's existing permission-review log when that log is enabled.

## License

[MIT](LICENSE)
