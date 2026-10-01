# @mzwing/pi-model-info

[![npm](https://img.shields.io/npm/v/@mzwing/pi-model-info)](https://www.npmjs.com/package/@mzwing/pi-model-info)

A [Pi](https://pi.dev) extension that completes the metadata of third-party models — context window, max tokens, pricing, capabilities and thinking levels — from the [pi.dev](https://pi.dev/api/models) and [models.dev](https://models.dev) catalogs, where Pi would otherwise use placeholders. It never creates providers, discovers models or writes to your files, and works alongside discovery extensions such as [`pi-openai-api-models-sync`](https://www.npmjs.com/package/pi-openai-api-models-sync).

## Install

```bash
pi install npm:@mzwing/pi-model-info
```

## Usage

Nothing happens until a provider is opted in, in `~/.pi/agent/extensions/pi-model-info/config.json` or `.pi/extensions/pi-model-info/config.json` (the project wins):

```json
{
  "providers": { "my-relay": {} }
}
```

A model is matched by its alias, then its exact id, then its id with at most one prefix and one suffix rule removed. An ambiguous match changes nothing, and fields you hand-wrote in `models.json` always win.

`/model-info` summarises what was completed, `/model-info <provider>/<model>` shows where each field came from, and `/model-info refresh` re-checks the catalogs.

## Configuration

Per provider, under `providers`:

| Key                   | Default   | Description                                                       |
| --------------------- | --------- | ----------------------------------------------------------------- |
| `catalogProvider`     | —         | Scope lookups to one catalog provider, e.g. `openrouter`          |
| `costMultiplier`      | `1`       | Markup applied to catalog pricing                                 |
| `costPolicy`          | `catalog` | `zero` forces free, `keep` leaves pricing alone                   |
| `contextWindowPolicy` | `catalog` | `min` never raises Pi's limits, `keep` leaves them alone          |
| `capabilityPolicy`    | `catalog` | `widen` only adds capabilities, `keep` leaves them alone          |
| `useCatalogName`      | `false`   | Rename models to their catalog names                              |
| `mapThinkingLevels`   | `false`   | Derive thinking levels from models.dev                            |
| `allowDynamic`        | `false`   | Silence the warning when a refreshing provider's list gets frozen |
| `models`              | —         | Per-model `alias`, `override`, `skip`, `prefixes` and `suffixes`  |

Rules strip an affix before matching. `-free` and `:free` are built in and set the cost to zero:

```json
{
  "rules": [
    {
      "id": "mainfei",
      "kind": "suffix",
      "value": "-mainfei",
      "override": { "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }
    }
  ]
}
```

See the [example config](./config/config.example.json) and the [JSON Schema](./schemas/config.schema.json) for every option.

## License

[MIT](./LICENSE)
