# pi-packages

My monorepo of [Pi](https://github.com/earendil-works/pi) extension packages.

## Packages

| Package                                                                        | Description                                                                   | Downloads/month                                                                                                                                |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [@mzwing/pi-codex-downgrade-detector](./packages/pi-codex-downgrade-detector/) | Tells you when a turn was served by a model other than the one you selected   | [![npm](https://img.shields.io/npm/dm/@mzwing/pi-codex-downgrade-detector)](https://www.npmjs.com/package/@mzwing/pi-codex-downgrade-detector) |
| [@mzwing/pi-codex-enhancer](./packages/pi-codex-enhancer/)                     | Keeps a valid 292-length `x-codex-turn-state` on every Codex request          | [![npm](https://img.shields.io/npm/dm/@mzwing/pi-codex-enhancer)](https://www.npmjs.com/package/@mzwing/pi-codex-enhancer)                     |
| [@mzwing/pi-model-info](./packages/pi-model-info/)                             | Completes third-party model metadata from the pi.dev and models.dev catalogs  | [![npm](https://img.shields.io/npm/dm/@mzwing/pi-model-info)](https://www.npmjs.com/package/@mzwing/pi-model-info)                             |
| [@mzwing/pi-permission-auto-review](./packages/pi-permission-auto-review/)     | Codex-style automatic permission reviews for `@gotgenes/pi-permission-system` | [![npm](https://img.shields.io/npm/dm/@mzwing/pi-permission-auto-review)](https://www.npmjs.com/package/@mzwing/pi-permission-auto-review)     |

## Development

I recommend using [devenv](https://devenv.sh/) to get consistent development shell.

More command can be found in the [package.json](./package.json).

## License

[MIT](LICENSE)
