# @mzwing/pi-codex-downgrade-detector

[![npm](https://img.shields.io/npm/v/@mzwing/pi-codex-downgrade-detector)](https://www.npmjs.com/package/@mzwing/pi-codex-downgrade-detector)

Tells you when a [Pi](https://pi.dev) turn was served by a model other than the one you selected.

A substituted turn and a clean turn look identical in the transcript. This reads the model the
server itself named — the `openai-model` response header, or the model field a completions-style
relay echoes back — compares it against what Pi asked for, and puts the answer in the footer:

```
✓ codex gpt-6-astra                 the server confirmed your model
↓ codex gpt-6-astra→gpt-5.6-luna    something cheaper answered
↑ codex gpt-5.4→gpt-6-astra         something else answered, still not what you picked
⚠ codex gpt-6-astra≠claude-opus-5   different, with no ordering between them
⚠ codex gpt-6-astra · xhigh→medium  the model matched, the reasoning effort did not
? codex gpt-6-astra unverified      nothing named a model, so nothing is confirmed
```

The first time a session sees a substitution it also raises a notification, once per
`requested→served` pair.

Nothing here judges answer quality, and nothing leaves your machine.

## Install

```bash
pi install npm:@mzwing/pi-codex-downgrade-detector
```

## Configuration

Optional. Both scopes are merged, project over global; `tiers` merges key by key.

| Scope   | Path                                                             |
| ------- | ---------------------------------------------------------------- |
| Global  | `~/.pi/agent/extensions/pi-codex-downgrade-detector/config.json` |
| Project | `.pi/extensions/pi-codex-downgrade-detector/config.json`         |

| Field         | Default            | Description                                                                      |
| ------------- | ------------------ | -------------------------------------------------------------------------------- |
| `providers`   | `["openai-codex"]` | Provider ids to watch. `[]` watches every provider.                              |
| `tiers`       | `{}`               | `slug` to integer rank, higher meaning more capable. Extends the built-in table. |
| `checkEffort` | `true`             | Also compare the reasoning effort Pi sent against the level you selected.        |
| `notify`      | `true`             | Raise a notification the first time a pair is substituted.                       |

Rank a slug under `tiers` whenever the footer reports a direction it could not work out — a
brand-new model, or a relay's own house models.

## /codex-downgrade

`/codex-downgrade` prints every turn this session observed, and which signal named the served
model. `/codex-downgrade show` prints the resolved config and where it was read from.

## Limits

The served model is only as good as what the server states. If the provider does not expose the
`openai-model` header and does not echo a model back, the footer says `unverified` rather than
reporting a clean turn — silence is reported as silence, never as a pass.

The effort comparison is client-side. It reports what Pi put on the wire against what your
selected thinking level maps to for that model; nothing on the response side confirms the effort
the server actually used.

## License

[MIT](LICENSE)
