# @mzwing/pi-codex-downgrade-detector

## 0.6.0

### Minor Changes

- [`cc11df7`](https://github.com/mzwing/pi-packages/commit/cc11df7c65f5efc29d468f2479fb0b0407987218) Thanks [@mzwing](https://github.com/mzwing)! - feat: adapt to Pi 1.0, accept @gotgenes/pi-permission-system v37 – v39, and harden pi-permission-auto-review with lessons from @czottmann/pi-automode and upstream Codex
  
  pi-model-info now keeps a model's `samplingParamsByThinkingLevel`, new in Pi 1.0.2, when it re-registers a provider's models, instead of dropping it.
  
  The `@gotgenes/pi-permission-system` peer range moves to v37 – v39, which require Pi 1.0. Their breaking changes gate Pi's built-in MCP tools on the `mcp` surface and narrow the Pi infrastructure read bypass, leaving the authorizer surface unchanged.
  
  pi-permission-auto-review reads a project's `.pi/extensions/pi-permission-auto-review/config.json` only once Pi trusts the project, as pi-permission-system does with its own project config, so an untrusted repository cannot swap in a policy that approves everything. `/permission-auto-review` refuses to edit an untrusted project's config, and `show` marks it as ignored.
  
  The reviewer sees the complete input of the tool call that raised the ask instead of pi-permission-system's preview, and the request is no longer truncated: an action too large for the reviewer model defers to the human prompt as `input-budget-exceeded`. Reviews use their own `auto-review:<session id>` session key, so they stop resetting the main conversation's Codex WebSocket continuation.
  
  Interrupting the turn cancels a running review at once and denies the ask, since deferring would open the prompt the user just escaped. A denial carries Codex's instruction against working around it, a malformed reply is retried within the review's budget, the reviewer's output is no longer capped at 1,000 tokens, and every decision logs the tokens it used. The footer shows whether the reviewer is registered and how many asks it allowed, denied or deferred.

## 0.5.0

### Minor Changes

- [`80b4ec9`](https://github.com/mzwing/pi-packages/commit/80b4ec97f3ac978195e01b789f7e9bb54b3ed82a) Thanks [@mzwing](https://github.com/mzwing)! - refactor: clean for a more clear structure, switch to a more modern writing, refine README

## 0.4.0

### Minor Changes

- [`4f31a6f`](https://github.com/mzwing/pi-packages/commit/4f31a6f364eeab49b907940a8dc88bbf9e844f78) Thanks [@mzwing](https://github.com/mzwing)! - feat: adapt to Pi 0.99.1 and accept @gotgenes/pi-permission-system v36

## 0.3.1

### Patch Changes

- [`d845495`](https://github.com/mzwing/pi-packages/commit/d845495fb78274f4fc6684e172247891a262995b) Thanks [@mzwing](https://github.com/mzwing)! - chore: accept Pi 0.87 and @gotgenes/pi-permission-system v34 and v35, reconcile the bundled Guardian policy against openai/codex@26cb4d73
  
  pi-model-info now keeps a model's `promptCache` and Pi 0.87's new `inputLimits` when it re-registers a provider's models, instead of dropping both.
  
  `@gotgenes/pi-permission-system` v34 and v35 leave the authorizer surface unchanged: their breaking changes gate a redirect's target against path rules, which authorizers already cannot auto-approve, and stop appending the tool surface to a custom system prompt.
  
  Upstream added an `{{ extra_policy }}` slot for operator policy at the end of the template's security policy (openai/codex#47125). pi-permission-auto-review's `additionalPolicy` now renders in that slot, as `## Operator Policy` ahead of the outcome rules instead of after them, so `POLICY_REVISION` moves to `+pi2`.

## 0.3.0

### Minor Changes

- [`c1a6e93`](https://github.com/mzwing/pi-packages/commit/c1a6e93e40395ed897d42dda278f3a70fb25c632) Thanks [@mzwing](https://github.com/mzwing)! - feat(pi-codex-enhancer, pi-codex-downgrade-detector): move the detail to a widget row and keep the footer to one glyph

## 0.2.0

### Minor Changes

- [`76a551a`](https://github.com/mzwing/pi-packages/commit/76a551a3eb5ba47ef5137407f8a15b1c36f9eab1) Thanks [@mzwing](https://github.com/mzwing)! - feat: adapt to Pi 0.86 and @gotgenes/pi-permission-system v33, reconcile the bundled Guardian policy
  
  The Pi peer range moves to `^0.86.0`. 0.86 replaces the pi-ai provider stream input with a normalized `TranscriptContext` and restricts `ToolCall.arguments` and `ToolResultMessage.details` to JSON values, so these packages are built and tested against that line only.
  
  `Provider.streamSimple()` no longer accepts a system prompt, so pi-permission-auto-review streams reviews through `ModelRegistry.streamSimple()` instead. That facade takes the prompt directly and resolves request-time authentication, so the reviewer no longer fetches an API key itself: an unusable Codex login now logs `provider-error` rather than the removed `auth-unresolved` category, and still defers to the human prompt. Its `@gotgenes/pi-permission-system` peer range narrows to v33, the only line tested against Pi 0.86 — that release's breaking changes are internal MCP rule matching, leaving the authorizer surface unchanged from v32.
  
  The bundled Guardian policy is reconciled against openai/codex@a8c36ca6, which moved `policy_template.md` and `policy.md` from `codex-rs/core/assets/guardian` to `codex-rs/prompts/templates/guardian` (openai/codex#46026). Both files are byte-identical across the move, so the adapted policy text is unchanged; only the tracked directory and the pinned revision recorded in `POLICY_REVISION` move.

## 0.1.0

### Minor Changes

- [`ecc7408`](https://github.com/mzwing/pi-packages/commit/ecc7408767ea46e051988104abfdac41dff1ad09) Thanks [@mzwing](https://github.com/mzwing)! - init(pi-codex-downgrade-detector): init project
