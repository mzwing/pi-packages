---
'@mzwing/pi-model-info': patch
---

feat(pi-model-info): complete a provider's models on read instead of freezing a snapshot of them

A provider was completed by snapshotting its list at `session_start` and registering a replacement. Because `applyExtension` swaps that list in wholesale, the replacement also became what `getProvider(id).getModels()` returned — so `reconcile()` compared our list against our list and could never see the provider's own refresh underneath. Every built-in provider is wrapped in a pi.dev catalog overlay that refreshes four-hourly and whenever `/model` opens, so for those the list was frozen for the whole session with no path back.

Completion is now applied in whichever of three ways claims the least, chosen per provider at `session_start`:

- **`native`** — nothing else has registered for the provider and it refreshes its own list: `pi.registerProvider(provider)` installs a wrapper whose `getModels()` completes the list underneath on every read. Pi's own dynamic providers keep their list in a closure `refreshModels()` rewrites, so reading late is what makes `/model`, the four-hourly refresh, and anything else that refreshes show newly discovered models already completed. `Symbol.for`-keyed markers keep a `/reload` unwrapping to the base rather than stacking wrappers, and `getModels()` never throws — Pi treats a throwing provider as having no models at all.
- **`decorate`** — a sibling registered `refreshModels`: that hook is wrapped, so what the sibling fetches is completed inside Pi's own refresh and rendered by the same `/model` pass that fetched it.
- **`replace`** — the previous behaviour, now only where nothing else is possible: another extension owns the registration slot, or models.json spells out the provider's `models[]` (which Pi rebuilds above anything registered underneath). This is the only strategy that freezes a list, and the only one that warns.

`/model-info` names the strategy in force per provider. `readUserAuthoredFields` now records every model models.json defines, not only those carrying a field worth preserving, because a bare definition still rules out lazy completion.
