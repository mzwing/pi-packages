# @mzwing/pi-model-info

## 0.1.0

### Minor Changes

- [`3c009dc`](https://github.com/mzwing/pi-packages/commit/3c009dc9ca805fb3a40143e9b7676f9daeda5c6b) Thanks [@mzwing](https://github.com/mzwing)! - Add `@mzwing/pi-model-info`, which completes third-party model metadata in Pi from the pi.dev and
  models.dev catalogs.
  
  Pi substitutes placeholders (`contextWindow: 128000`, `maxTokens: 16384`, `cost: {0,0,0,0}`,
  `reasoning: false`) for any model whose provider it has not indexed, which throws off compaction
  timing and cost accounting. This extension resolves each opted-in provider's model ids against
  both catalogs and injects the real values at runtime, without creating providers, discovering
  models, or writing to any user file.
  
  It is built to run alongside a discovery extension such as `pi-openai-api-models-sync`: that one
  finds which models a relay serves, this one completes what they are.
