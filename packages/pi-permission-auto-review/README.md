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

Requires Pi 1.0.0 or later and `@gotgenes/pi-permission-system` 37.x – 39.x.

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

| Field                   | Default             | Description                                             |
| ----------------------- | ------------------- | ------------------------------------------------------- |
| `provider`              | `openai-codex`      | Pi provider id of the reviewer model                    |
| `model`                 | `codex-auto-review` | Reviewer model id                                       |
| `reasoning`             | `low`               | Reasoning level for review calls                        |
| `timeoutMs`             | `90000`             | Total budget across retries                             |
| `includeBaselinePolicy` | `true`              | Include the bundled Guardian policy                     |
| `additionalPolicy`      | —                   | Operator policy, required when the baseline is disabled |

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
