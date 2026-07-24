# @mzwing/pi-polyfill

Compatibility helpers for [Pi](https://github.com/earendil-works/pi) extension APIs.

This is a library package, not a Pi extension. Install it as a dependency of an extension; do not add it separately to Pi's package configuration.

## Model Registry Provider Lookup

Pi 0.81 exposes `ModelRegistry.getProvider()`. Pi 0.80.10 has the same provider lookup on its internal model runtime but does not expose the registry method.

```ts
import { getModelRegistryProvider } from '@mzwing/pi-polyfill'

const provider = getModelRegistryProvider(modelRegistry, 'openai-codex')
```

`getModelRegistryProvider()` uses the public method when present. On Pi 0.80.10, it falls back to `ModelRegistry.runtime.getProvider()`. It does not modify or replace the supplied registry.

The compatibility fallback depends on the runtime-visible `ModelRegistry.runtime` field in Pi 0.80.10. If neither lookup is available, the helper returns `undefined`. Errors thrown by an available native or legacy implementation are preserved for the caller to handle.

## Compatibility

| Pi version | Provider lookup |
| ---------- | --------------- |
| `0.80.10`  | Legacy fallback |
| `0.81.x`   | Native API      |

Earlier Pi versions are not supported.

## License

[MIT](LICENSE)
