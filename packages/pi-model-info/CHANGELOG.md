# @mzwing/pi-model-info

## 0.7.1

### Patch Changes

- [`496aa20`](https://github.com/mzwing/pi-packages/commit/496aa2034b4107f408958cc1a2393646dfdf8cfb) Thanks [@mzwing](https://github.com/mzwing)! - perf(pi-model-info): register a provider again only when its catalog or model list changed
  
  A session that started on an unexpired cached catalog registered each completed provider twice, once from the cache and once more from the refresh that found it current, and every registration makes Pi rebuild and refresh its whole model list. It now registers once, and when another extension changes a provider's model list, only that provider registers again.

## 0.7.0

### Minor Changes

- [`da837db`](https://github.com/mzwing/pi-packages/commit/da837db821f043aef019227f1aaaab46c5d20d36) Thanks [@mzwing](https://github.com/mzwing)! - refactor: group `src/` and `test/` into folders by responsibility
  
  Each package keeps its modules in folders by subsystem instead of side by side in one `src/`, and its tests in matching folders under `test/`. Entry points, exports and config files are unchanged.

### Patch Changes

- [`2267bf4`](https://github.com/mzwing/pi-packages/commit/2267bf483c6647ef187caba736770fb3c5b0a889) Thanks [@mzwing](https://github.com/mzwing)! - chore: accept Pi 1.4 and @gotgenes/pi-permission-system v42
  
  The Pi peer range moves to `^1.4.0`, the line these packages are built and tested against. From 1.4.0 on, resuming a session that began before pi-session-hub was installed, `session_spawn`'s `resume` included, activates the hub's tools instead of leaving them off.
  
  pi-permission-auto-review accepts `@gotgenes/pi-permission-system` v42, whose only breaking change, a limit of 1,000 entries on each of its config arrays, does not affect the reviewer.

- [`4471e84`](https://github.com/mzwing/pi-packages/commit/4471e840317511541fa02c3d8b59eb7f89a44c79) Thanks [@mzwing](https://github.com/mzwing)! - fix: validate configs with valibot instead of zod
  
  pi-codex-downgrade-detector, pi-model-info, pi-permission-auto-review and pi-task-governor no longer depend on zod: they validate their config with valibot, bundled into each package, so installing one adds nothing beyond its peer dependencies. Config errors follow valibot's wording, and an unknown key is reported at its own path, as in `reasonning: Invalid key: Expected never but received "reasonning"`.
  
  pi-model-info reports a rule id or a source given twice against the file that repeats it. Before, it named the project's config file wherever the repeat was.

## 0.6.2

### Patch Changes

- [`386b523`](https://github.com/mzwing/pi-packages/commit/386b523873f189bad5c8a95b2c81b7996fd3784b) Thanks [@mzwing](https://github.com/mzwing)! - chore: accept Pi 1.3 and @gotgenes/pi-permission-system v41
  
  The Pi peer range moves to `^1.3.0`, the line these packages are built and tested against. From 1.3.0 on, a session that pi-session-hub's `session_spawn` continues with `resume` keeps its active tools instead of falling back to the default ones.
  
  pi-permission-auto-review accepts `@gotgenes/pi-permission-system` v41. Where v40 downgrades the reviewer's `allow` on every `path` and `external_directory` ask to `defer`, v41 lets it stand on a bash `external_directory` ask whose paths name nothing on disk, such as the spreadsheet cell in `officecli set data.xlsx /Sheet1/B1`. The license that marks such an ask reaches the reviewer with the rest of the request.

## 0.6.1

### Patch Changes

- [`758ce8b`](https://github.com/mzwing/pi-packages/commit/758ce8b72f3734d6521bda4ee4f1bc39716aa316) Thanks [@mzwing](https://github.com/mzwing)! - fix(pi-task-governor): increase pi peer to fix a run that a message started lost the prompt text extensions add in `before_agent_start`
  
  The Pi peer range moves to `^1.2.0`.
  
  Before 1.2.0, a run that a message started lost the prompt text extensions add in `before_agent_start`, so a pi-task-governor coordinator that session-hub mail woke up worked without its role instructions.

## 0.6.0

### Minor Changes

- [`6af2cc5`](https://github.com/mzwing/pi-packages/commit/6af2cc59d08ea7dcd455af6123b4a9c68df4d6f4) Thanks [@mzwing](https://github.com/mzwing)! - feat: adapt to Pi 1.1 and jj 0.46, and accept @gotgenes/pi-permission-system v40
  
  The Pi peer range moves to `^1.1.0`, the line these packages are built and tested against.
  
  pi-permission-auto-review accepts `@gotgenes/pi-permission-system` v40, whose breaking change matches a bash rule written with an absolute path against the relative spelling of that path, leaving the authorizer surface unchanged. The spelling a rule matched, which v40 adds to an ask, reaches the reviewer with the rest of the request.
  
  Since Pi 1.0.4, `--tools` no longer removes MCP tools, so pi-task-governor starts its executors with `--no-mcp`: they work with their fixed tool set alone and connect to no MCP servers.
  
  pi-task-governor now requires jj 0.46. That release turns a workspace added to a colocated repository into a Git worktree by default, so task workspaces are added with `--no-colocate` and stay without `.git`, as the task environment and the developer prompt expect.

## 0.5.0

### Minor Changes

- [`cc11df7`](https://github.com/mzwing/pi-packages/commit/cc11df7c65f5efc29d468f2479fb0b0407987218) Thanks [@mzwing](https://github.com/mzwing)! - feat: adapt to Pi 1.0, accept @gotgenes/pi-permission-system v37 – v39, and harden pi-permission-auto-review with lessons from @czottmann/pi-automode and upstream Codex
  
  pi-model-info now keeps a model's `samplingParamsByThinkingLevel`, new in Pi 1.0.2, when it re-registers a provider's models, instead of dropping it.
  
  The `@gotgenes/pi-permission-system` peer range moves to v37 – v39, which require Pi 1.0. Their breaking changes gate Pi's built-in MCP tools on the `mcp` surface and narrow the Pi infrastructure read bypass, leaving the authorizer surface unchanged.
  
  pi-permission-auto-review reads a project's `.pi/extensions/pi-permission-auto-review/config.json` only once Pi trusts the project, as pi-permission-system does with its own project config, so an untrusted repository cannot swap in a policy that approves everything. `/permission-auto-review` refuses to edit an untrusted project's config, and `show` marks it as ignored.
  
  The reviewer sees the complete input of the tool call that raised the ask instead of pi-permission-system's preview, and the request is no longer truncated: an action too large for the reviewer model defers to the human prompt as `input-budget-exceeded`. Reviews use their own `auto-review:<session id>` session key, so they stop resetting the main conversation's Codex WebSocket continuation.
  
  Interrupting the turn cancels a running review at once and denies the ask, since deferring would open the prompt the user just escaped. A denial carries Codex's instruction against working around it, a malformed reply is retried within the review's budget, the reviewer's output is no longer capped at 1,000 tokens, and every decision logs the tokens it used. The footer shows whether the reviewer is registered and how many asks it allowed, denied or deferred.

## 0.4.0

### Minor Changes

- [`80b4ec9`](https://github.com/mzwing/pi-packages/commit/80b4ec97f3ac978195e01b789f7e9bb54b3ed82a) Thanks [@mzwing](https://github.com/mzwing)! - refactor: clean for a more clear structure, switch to a more modern writing, refine README

## 0.3.0

### Minor Changes

- [`4f31a6f`](https://github.com/mzwing/pi-packages/commit/4f31a6f364eeab49b907940a8dc88bbf9e844f78) Thanks [@mzwing](https://github.com/mzwing)! - feat: adapt to Pi 0.99.1 and accept @gotgenes/pi-permission-system v36

## 0.2.1

### Patch Changes

- [`d845495`](https://github.com/mzwing/pi-packages/commit/d845495fb78274f4fc6684e172247891a262995b) Thanks [@mzwing](https://github.com/mzwing)! - chore: accept Pi 0.87 and @gotgenes/pi-permission-system v34 and v35, reconcile the bundled Guardian policy against openai/codex@26cb4d73
  
  pi-model-info now keeps a model's `promptCache` and Pi 0.87's new `inputLimits` when it re-registers a provider's models, instead of dropping both.
  
  `@gotgenes/pi-permission-system` v34 and v35 leave the authorizer surface unchanged: their breaking changes gate a redirect's target against path rules, which authorizers already cannot auto-approve, and stop appending the tool surface to a custom system prompt.
  
  Upstream added an `{{ extra_policy }}` slot for operator policy at the end of the template's security policy (openai/codex#47125). pi-permission-auto-review's `additionalPolicy` now renders in that slot, as `## Operator Policy` ahead of the outcome rules instead of after them, so `POLICY_REVISION` moves to `+pi2`.

## 0.2.0

### Minor Changes

- [`76a551a`](https://github.com/mzwing/pi-packages/commit/76a551a3eb5ba47ef5137407f8a15b1c36f9eab1) Thanks [@mzwing](https://github.com/mzwing)! - feat: adapt to Pi 0.86 and @gotgenes/pi-permission-system v33, reconcile the bundled Guardian policy
  
  The Pi peer range moves to `^0.86.0`. 0.86 replaces the pi-ai provider stream input with a normalized `TranscriptContext` and restricts `ToolCall.arguments` and `ToolResultMessage.details` to JSON values, so these packages are built and tested against that line only.
  
  `Provider.streamSimple()` no longer accepts a system prompt, so pi-permission-auto-review streams reviews through `ModelRegistry.streamSimple()` instead. That facade takes the prompt directly and resolves request-time authentication, so the reviewer no longer fetches an API key itself: an unusable Codex login now logs `provider-error` rather than the removed `auth-unresolved` category, and still defers to the human prompt. Its `@gotgenes/pi-permission-system` peer range narrows to v33, the only line tested against Pi 0.86 — that release's breaking changes are internal MCP rule matching, leaving the authorizer surface unchanged from v32.
  
  The bundled Guardian policy is reconciled against openai/codex@a8c36ca6, which moved `policy_template.md` and `policy.md` from `codex-rs/core/assets/guardian` to `codex-rs/prompts/templates/guardian` (openai/codex#46026). Both files are byte-identical across the move, so the adapted policy text is unchanged; only the tracked directory and the pinned revision recorded in `POLICY_REVISION` move.

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
