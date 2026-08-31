# @mzwing/pi-model-info

## 0.1.1

### Patch Changes

- [`b4faaa3`](https://github.com/mzwing/pi-packages/commit/b4faaa38c9d762001dcf7d39f04f54aa44bc8f73) Thanks [@mzwing](https://github.com/mzwing)! - feat(pi-model-info): complete a provider's models on read instead of freezing a snapshot of them
  
  A provider was completed by snapshotting its list at `session_start` and registering a replacement. Because `applyExtension` swaps that list in wholesale, the replacement also became what `getProvider(id).getModels()` returned — so `reconcile()` compared our list against our list and could never see the provider's own refresh underneath. Every built-in provider is wrapped in a pi.dev catalog overlay that refreshes four-hourly and whenever `/model` opens, so for those the list was frozen for the whole session with no path back.
  
  Completion is now applied in whichever of three ways claims the least, chosen per provider at `session_start`:
  
  - **`native`** — nothing else has registered for the provider and it refreshes its own list: `pi.registerProvider(provider)` installs a wrapper whose `getModels()` completes the list underneath on every read. Pi's own dynamic providers keep their list in a closure `refreshModels()` rewrites, so reading late is what makes `/model`, the four-hourly refresh, and anything else that refreshes show newly discovered models already completed. `Symbol.for`-keyed markers keep a `/reload` unwrapping to the base rather than stacking wrappers, and `getModels()` never throws — Pi treats a throwing provider as having no models at all.
  - **`decorate`** — a sibling registered `refreshModels`: that hook is wrapped, so what the sibling fetches is completed inside Pi's own refresh and rendered by the same `/model` pass that fetched it.
  - **`replace`** — the previous behaviour, now only where nothing else is possible: another extension owns the registration slot, or models.json spells out the provider's `models[]` (which Pi rebuilds above anything registered underneath). This is the only strategy that freezes a list, and the only one that warns.
  
  `/model-info` names the strategy in force per provider. `readUserAuthoredFields` now records every model models.json defines, not only those carrying a field worth preserving, because a bare definition still rules out lazy completion.

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
