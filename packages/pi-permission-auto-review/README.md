# @mzwing/pi-permission-auto-review

[![npm](https://img.shields.io/npm/v/@mzwing/pi-permission-auto-review)](https://www.npmjs.com/package/@mzwing/pi-permission-auto-review)

A [Pi](https://github.com/earendil-works/pi) extension that adds Codex-style automatic permission reviews to [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system). Each ask is judged by OpenAI's `codex-auto-review` model against a bundled adaptation of the [OpenAI Codex Guardian policy](https://github.com/openai/codex/tree/main/codex-rs/prompts/templates/guardian); whatever it cannot decide falls through to the normal prompt.

## Differences between @gotgenes/pi-permission-model-judge

`@gotgenes/pi-permission-model-judge` is a general-purpose model-based authorizer that can be used to evaluate any permission request.

Ours is mostly specialized for OpenAI's codex-auto-review model, which is trained to evaluate permission requests in the context of a coding assistant. Our extension aims at providing Codex-style automatic permission reviews for Pi.

## Install

```bash
pi install npm:@gotgenes/pi-permission-system
pi install npm:@mzwing/pi-permission-auto-review
```

Requires Pi 1.3.0 or later and `@gotgenes/pi-permission-system` 37.x – 41.x.

## Usage

Add the authorizer to pi-permission-system's config, normally `~/.pi/agent/extensions/pi-permission-system/config.json`:

```json
{
  "authorizerChain": ["auto-review"]
}
```

The default model reuses Pi's `openai-codex` login, listed as "OpenAI Codex (legacy)" in `/login`.

`/permission-auto-review` edits the config interactively and applies it without reloading the session. Its subcommands are `show`, `path`, `reset [global|project]` and `help`.

The footer shows whether the reviewer is registered and how many asks it has allowed, denied or deferred in the session.

## Configuration

Optional. `~/.pi/agent/extensions/pi-permission-auto-review/config.json` and `.pi/extensions/pi-permission-auto-review/config.json` are merged, the project over the global one; the project file is read only once Pi trusts the project. An invalid config disables automatic decisions.

| Field                   | Default             | Description                                                  |
| ----------------------- | ------------------- | ------------------------------------------------------------ |
| `provider`              | `openai-codex`      | Pi provider id of the reviewer model                         |
| `model`                 | `codex-auto-review` | Reviewer model id                                            |
| `reasoning`             | `low`               | Reasoning level for review calls                             |
| `timeoutMs`             | `90000`             | Total budget for one review, including every retry and pause |
| `maxRetries`            | `2`                 | Retries after the first call, from 0 to 20                   |
| `attemptTimeoutMs`      | not set             | Longest time one call may take, from 1 to 300000 ms          |
| `includeBaselinePolicy` | `true`              | Include the bundled Guardian policy                          |
| `additionalPolicy`      | —                   | Operator policy, required when the baseline is disabled      |

### Retries

A review retries a call that fails or returns a reply it cannot parse. `maxRetries` counts the calls after the first one, so the default of 2 allows at most 3 calls and 0 allows one. A valid denial is never retried. Neither is a failure that happens before the first call, such as an unknown provider or model, or a prompt too large for the model.

The pause before each retry is 250 ms, then 1 s, 4 s and 16 s, and 30 s for every retry after that.

`timeoutMs` bounds the whole review. When it runs out, the review stops, during a call or a pause, and defers to the next authorizer. Extra retries help only if `timeoutMs` leaves room for them.

Without `attemptTimeoutMs`, one stalled call can use up all of `timeoutMs`. With it, the review abandons a call after that many milliseconds and retries. The limit counts from the start of the call, so it also cuts off a slow reply that is still arriving. The extension discards the late reply, but the provider may keep working on the abandoned request. A call never gets more than what is left of `timeoutMs`.

For unattended runs, this config allows up to 8 calls of at most 60 s each within 3 minutes:

```json
{
  "timeoutMs": 180000,
  "maxRetries": 7,
  "attemptTimeoutMs": 60000
}
```

Additional retries can increase model usage and delay the human prompt. A persistent failure, such as an expired login, still causes a deferral once the retry count or total budget is exhausted.

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

## License

[MIT](LICENSE)
