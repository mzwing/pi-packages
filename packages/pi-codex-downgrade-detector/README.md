# @mzwing/pi-codex-downgrade-detector

[![npm](https://img.shields.io/npm/v/@mzwing/pi-codex-downgrade-detector)](https://www.npmjs.com/package/@mzwing/pi-codex-downgrade-detector)

A [Pi](https://pi.dev) extension that tells you when a turn was served by a model other than the one you selected. It compares the model the server names — the `openai-model` response header, or the model a relay echoes back — with the one Pi asked for.

## Install

```bash
pi install npm:@mzwing/pi-codex-downgrade-detector
```

## Usage

The footer keeps one glyph for the latest turn:

| Glyph | Meaning                                             |
| ----- | --------------------------------------------------- |
| `·`   | No turn has finished yet                            |
| `✓`   | The server confirmed your model                     |
| `↓`   | Something cheaper answered                          |
| `↑`   | Something else answered, still not what you picked  |
| `⚠`   | A different model, or the reasoning effort differed |
| `?`   | Nothing named a model, so nothing is confirmed      |

When a turn diverges, a row above the editor names both models, and the first substitution of each pair raises a notification.

`/codex-downgrade` lists the turns this session observed; `/codex-downgrade show` prints the resolved config.

## Configuration

Optional. `~/.pi/agent/extensions/pi-codex-downgrade-detector/config.json` and `.pi/extensions/pi-codex-downgrade-detector/config.json` are merged, the project over the global one.

| Field         | Default            | Description                                                         |
| ------------- | ------------------ | ------------------------------------------------------------------- |
| `providers`   | `["openai-codex"]` | Provider ids to watch. `[]` watches every provider.                 |
| `tiers`       | `{}`               | Extra `slug` → rank entries, higher meaning more capable.           |
| `checkEffort` | `true`             | Also compare the reasoning effort Pi sent with your selected level. |
| `notify`      | `true`             | Notify the first time a pair is substituted.                        |

## Credits

<https://t.me/c/2502727045/42320>

Super thx for opening the detecting verdict out!

## License

[MIT](LICENSE)
