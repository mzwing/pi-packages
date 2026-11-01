# @mzwing/pi-permission-auto-review

[![npm](https://img.shields.io/npm/v/@mzwing/pi-permission-auto-review)](https://www.npmjs.com/package/@mzwing/pi-permission-auto-review)

A [Pi](https://github.com/earendil-works/pi) extension that adds automatic permission reviews to [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system). Each ask is judged by a reviewer model first; whatever it cannot decide falls through to the normal prompt. A preset picks the reviewer:

- `codex`, the default: OpenAI's `codex-auto-review` model against a bundled adaptation of the [OpenAI Codex Guardian policy](https://github.com/openai/codex/tree/main/codex-rs/prompts/templates/guardian).
- `claude-code`: the two-stage check of [Claude Code's auto mode](https://code.claude.com/docs/en/auto-mode-config), on Claude Sonnet 5 by default, with its prompt and rules written anew for Pi.

## Differences between @gotgenes/pi-permission-model-judge

`@gotgenes/pi-permission-model-judge` is a general-purpose model-based authorizer that can be used to evaluate any permission request.

Ours reproduces the reviewers of two coding agents, Codex's auto-review and Claude Code's auto mode, each with the prompt, transcript and review flow it was built around.

## Install

```bash
pi install npm:@gotgenes/pi-permission-system
pi install npm:@mzwing/pi-permission-auto-review
```

Requires Pi 1.4.0 or later and `@gotgenes/pi-permission-system` 37.x – 42.x.

## Usage

Add the authorizer to pi-permission-system's config, normally `~/.pi/agent/extensions/pi-permission-system/config.json`:

```json
{
  "authorizerChain": ["auto-review"]
}
```

The `codex` preset reuses Pi's `openai-codex` login, listed as "OpenAI Codex (legacy)" in `/login`; the `claude-code` preset needs an `anthropic` login. Either can run on another model through `provider` and `model`.

Claude Code approves most reads and edits inside the project without its reviewer; to do the same, allow them in pi-permission-system's own rules, so that only riskier asks reach the reviewer.

`/permission-auto-review` edits the config interactively and applies it without reloading the session. Its subcommands are `show`, `path`, `defaults` (the built-in rules of the active preset), `reset [global|project]` and `help`.

The footer shows whether the reviewer is registered and how many asks it has allowed, denied or deferred in the session.

## Configuration

Optional. `~/.pi/agent/extensions/pi-permission-auto-review/config.json` and `.pi/extensions/pi-permission-auto-review/config.json` are merged, the project over the global one; the project file is read only once Pi trusts the project. An invalid config disables automatic decisions.

| Field              | Default (`codex` / `claude-code`)       | Description                                                   |
| ------------------ | --------------------------------------- | ------------------------------------------------------------- |
| `preset`           | `codex`                                 | `codex` or `claude-code`                                      |
| `provider`         | `openai-codex` / `anthropic`            | Pi provider id of the reviewer model                          |
| `model`            | `codex-auto-review` / `claude-sonnet-5` | Reviewer model id                                             |
| `reasoning`        | `low` / `off`                           | Reasoning level for review calls                              |
| `timeoutMs`        | `90000`                                 | Total budget across retries                                   |
| `maxRetries`       | `2`                                     | Retries when a call fails or its reply is malformed           |
| `attemptTimeoutMs` | —                                       | Time limit for one call; without it, only `timeoutMs` applies |
| `followUpReviews`  | `auto`                                  | Continue the reviewer's conversation across asks; see below   |
| `autoMode`         | —                                       | Rules beside or instead of the preset's own; see below        |

`autoMode` takes the same four lists as Claude Code's own `autoMode` settings, so rules copied from there paste in. `environment` tells the reviewer what lies inside your trust boundary, `hard_deny` rules always block, and `soft_deny` rules block unless an `allow` exception or the user's explicit consent clears them. Each is a list of prose rules: the entry `"$defaults"` stands for the preset's built-in rules, and a list without it replaces them. Under `codex`, `"$defaults"` keeps the Guardian policy's sections where they are, and your other rules join it as operator policy.

```json
{
  "preset": "claude-code",
  "autoMode": {
    "environment": ["$defaults", "Source control: github.com/acme and every repository under it"],
    "soft_deny": ["$defaults", "Never run database migrations by hand"]
  }
}
```

Like Codex, a later ask in a session continues the reviewer's conversation and sends only what the session added since the last review. The conversation starts over in full when it would pass 256k tokens or overflow the reviewer's context window, when the session moves to another branch, or after a review fails. `auto` also starts over after a follow-up the provider served without a cache hit, so a provider that does not cache never resends a growing conversation; `always` keeps the conversation then, and `off` sends every review in full, as Claude Code does.

## Programmatic use

`@mzwing/pi-permission-auto-review/review` exports the prompt and verdict pipeline without needing Pi at runtime:

```ts
import {
  buildReviewPrompt,
  DEFAULT_CONFIG,
  findToolCallInput,
  parseReviewAssessment,
  renderTranscript,
} from '@mzwing/pi-permission-auto-review/review'

const toolInput = findToolCallInput(sessionEntries, details.toolCallId)
const prompt = buildReviewPrompt(DEFAULT_CONFIG, renderTranscript(sessionEntries), details, toolInput)
const assessment = parseReviewAssessment(modelReply)
```

The `claude-code` pipeline sits beside it, under names such as `buildClaudeCodeSystemPrompt`, `renderClaudeCodeTranscript` and `parseClaudeCodeVerdict`.

## License

[MIT](LICENSE)
