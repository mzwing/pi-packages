# @mzwing/pi-permission-auto-review

## 1.0.0

### Major Changes

- [`0d468aa`](https://github.com/mzwing/pi-packages/commit/0d468aa62deabfb1aeb53bfc0e07ad6cf982945a) Thanks [@mzwing](https://github.com/mzwing)! - feat(pi-permission-auto-review): add Claude Code auto mode prompt preset, support more accurate control options
  
  `preset` picks the reviewer. `codex`, the default, keeps the Codex Guardian review. `claude-code` follows Claude Code's auto mode, on `anthropic`/`claude-sonnet-5` by default: a short first pass lets only clearly safe actions through, and a second pass that reasons first decides the rest, over a transcript of the user's messages and the agent's calls without their output. Its prompt and rules are written for Pi, not copied from Claude Code. It hands the third denial in a row, and the twentieth in total, to the human prompt, and it shows the reviewer the user's AGENTS.md and CLAUDE.md, a project's own only once Pi trusts the project. `/permission-auto-review defaults` lists the active preset's built-in rules.
  
  Both presets take their rules from `autoMode`, whose `environment`, `allow`, `soft_deny` and `hard_deny` lists match Claude Code's `autoMode` settings. The entry `"$defaults"` stands for the preset's built-in rules, a list without it replaces them, and a project's list replaces only the global list of its name. `autoMode` replaces `includeBaselinePolicy` and `additionalPolicy`, so a config that still sets either fails validation until it is migrated:
  
  - The text of `additionalPolicy` becomes an entry beside `"$defaults"` in `autoMode.soft_deny`, in `autoMode.hard_deny` for a rule no approval may lift, or in `autoMode.allow` for an exception.
  - `"includeBaselinePolicy": false` becomes `soft_deny` and `allow` lists without `"$defaults"`. The Guardian policy's authorization scoring, risk taxonomy and outcome rules stay.
  
  Follow-up reviews work under both presets, and a conversation also starts over once it would pass 256k tokens, so a model with a larger context window does not reread an ever longer one.
  
  `AutoReviewConfig`, exported from `@mzwing/pi-permission-auto-review/review`, gains `preset` and `autoMode` and loses `includeBaselinePolicy` and `additionalPolicy`. The subpath also exports the `claude-code` pipeline, under names such as `buildClaudeCodeSystemPrompt` and `parseClaudeCodeVerdict`.

### Minor Changes

- [`496aa20`](https://github.com/mzwing/pi-packages/commit/496aa2034b4107f408958cc1a2393646dfdf8cfb) Thanks [@mzwing](https://github.com/mzwing)! - feat(pi-permission-auto-review): continue the reviewer's conversation instead of resending the whole transcript
  
  As Codex does, a later ask in a session extends the reviewer's conversation with only what the session added since the last review, so a provider with a prompt cache reads the earlier reviews from it, and an ask beside a tool call reviewed a moment ago sends little more than its own request. The conversation starts over in full when it would overflow the reviewer's context window, when the session moves to another branch, or after a review fails.
  
  `followUpReviews` sets the mode. `auto`, the default, also starts over after a follow-up the provider served without a cache hit, so a provider that does not cache never resends a growing conversation; `always` keeps the conversation then, and `off` sends every review in full. The review log's `priorReviews` counts the reviews a request continued, and `policyRevision` ends in `+pi3`.
  
  `AutoReviewConfig`, exported from `@mzwing/pi-permission-auto-review/review`, now requires `followUpReviews`, which `DEFAULT_CONFIG` includes, and `renderTranscript` takes the index of the first entry to render.

### Patch Changes

- [`496aa20`](https://github.com/mzwing/pi-packages/commit/496aa2034b4107f408958cc1a2393646dfdf8cfb) Thanks [@mzwing](https://github.com/mzwing)! - fix(pi-permission-auto-review): log review usage under keys the review log does not mask
  
  pi-permission-system masks every logged value whose key names a token or an authorization, so the review log showed `[redacted]` for `inputTokens`, `cacheReadTokens`, `outputTokens` and `userAuthorization`. A decision now logs `usage` with `input`, `cacheRead` and `output`, and the reviewer's authorization grade as `userApproval`.

## 0.10.0

### Minor Changes

- [#34](https://github.com/mzwing/pi-packages/pull/34) [`0b8ac4c`](https://github.com/mzwing/pi-packages/commit/0b8ac4c02fc2bf139d328f82ac2c1192b48a16ec) Thanks [@asdfML](https://github.com/asdfML)! - feat(pi-permission-auto-review): configure review retries and a time limit for each call
  
  `maxRetries` sets how many times a review retries a call that fails or returns a malformed reply, from 0 to 20 and 2 by default. `attemptTimeoutMs` abandons a call that runs longer and retries it like a failed one; without it, a call can run until `timeoutMs` ends the review. The pause between retries grows from 250 ms to at most 30 seconds, and the calls and pauses together stay within `timeoutMs`.
  
  `AutoReviewConfig`, exported from `@mzwing/pi-permission-auto-review/review`, now requires `maxRetries`, which `DEFAULT_CONFIG` includes.

- [`da837db`](https://github.com/mzwing/pi-packages/commit/da837db821f043aef019227f1aaaab46c5d20d36) Thanks [@mzwing](https://github.com/mzwing)! - refactor: group `src/` and `test/` into folders by responsibility
  
  Each package keeps its modules in folders by subsystem instead of side by side in one `src/`, and its tests in matching folders under `test/`. Entry points, exports and config files are unchanged.

### Patch Changes

- [`2267bf4`](https://github.com/mzwing/pi-packages/commit/2267bf483c6647ef187caba736770fb3c5b0a889) Thanks [@mzwing](https://github.com/mzwing)! - chore: accept Pi 1.4 and @gotgenes/pi-permission-system v42
  
  The Pi peer range moves to `^1.4.0`, the line these packages are built and tested against. From 1.4.0 on, resuming a session that began before pi-session-hub was installed, `session_spawn`'s `resume` included, activates the hub's tools instead of leaving them off.
  
  pi-permission-auto-review accepts `@gotgenes/pi-permission-system` v42, whose only breaking change, a limit of 1,000 entries on each of its config arrays, does not affect the reviewer.

- [`4471e84`](https://github.com/mzwing/pi-packages/commit/4471e840317511541fa02c3d8b59eb7f89a44c79) Thanks [@mzwing](https://github.com/mzwing)! - fix: validate configs with valibot instead of zod
  
  pi-codex-downgrade-detector, pi-model-info, pi-permission-auto-review and pi-task-governor no longer depend on zod: they validate their config with valibot, bundled into each package, so installing one adds nothing beyond its peer dependencies. Config errors follow valibot's wording, and an unknown key is reported at its own path, as in `reasonning: Invalid key: Expected never but received "reasonning"`.
  
  pi-model-info reports a rule id or a source given twice against the file that repeats it. Before, it named the project's config file wherever the repeat was.

## 0.9.2

### Patch Changes

- [`386b523`](https://github.com/mzwing/pi-packages/commit/386b523873f189bad5c8a95b2c81b7996fd3784b) Thanks [@mzwing](https://github.com/mzwing)! - chore: accept Pi 1.3 and @gotgenes/pi-permission-system v41
  
  The Pi peer range moves to `^1.3.0`, the line these packages are built and tested against. From 1.3.0 on, a session that pi-session-hub's `session_spawn` continues with `resume` keeps its active tools instead of falling back to the default ones.
  
  pi-permission-auto-review accepts `@gotgenes/pi-permission-system` v41. Where v40 downgrades the reviewer's `allow` on every `path` and `external_directory` ask to `defer`, v41 lets it stand on a bash `external_directory` ask whose paths name nothing on disk, such as the spreadsheet cell in `officecli set data.xlsx /Sheet1/B1`. The license that marks such an ask reaches the reviewer with the rest of the request.

## 0.9.1

### Patch Changes

- [`758ce8b`](https://github.com/mzwing/pi-packages/commit/758ce8b72f3734d6521bda4ee4f1bc39716aa316) Thanks [@mzwing](https://github.com/mzwing)! - fix(pi-task-governor): increase pi peer to fix a run that a message started lost the prompt text extensions add in `before_agent_start`
  
  The Pi peer range moves to `^1.2.0`.
  
  Before 1.2.0, a run that a message started lost the prompt text extensions add in `before_agent_start`, so a pi-task-governor coordinator that session-hub mail woke up worked without its role instructions.

## 0.9.0

### Minor Changes

- [`6af2cc5`](https://github.com/mzwing/pi-packages/commit/6af2cc59d08ea7dcd455af6123b4a9c68df4d6f4) Thanks [@mzwing](https://github.com/mzwing)! - feat: adapt to Pi 1.1 and jj 0.46, and accept @gotgenes/pi-permission-system v40
  
  The Pi peer range moves to `^1.1.0`, the line these packages are built and tested against.
  
  pi-permission-auto-review accepts `@gotgenes/pi-permission-system` v40, whose breaking change matches a bash rule written with an absolute path against the relative spelling of that path, leaving the authorizer surface unchanged. The spelling a rule matched, which v40 adds to an ask, reaches the reviewer with the rest of the request.
  
  Since Pi 1.0.4, `--tools` no longer removes MCP tools, so pi-task-governor starts its executors with `--no-mcp`: they work with their fixed tool set alone and connect to no MCP servers.
  
  pi-task-governor now requires jj 0.46. That release turns a workspace added to a colocated repository into a Git worktree by default, so task workspaces are added with `--no-colocate` and stay without `.git`, as the task environment and the developer prompt expect.

## 0.8.0

### Minor Changes

- [`cc11df7`](https://github.com/mzwing/pi-packages/commit/cc11df7c65f5efc29d468f2479fb0b0407987218) Thanks [@mzwing](https://github.com/mzwing)! - feat: adapt to Pi 1.0, accept @gotgenes/pi-permission-system v37 – v39, and harden pi-permission-auto-review with lessons from @czottmann/pi-automode and upstream Codex
  
  pi-model-info now keeps a model's `samplingParamsByThinkingLevel`, new in Pi 1.0.2, when it re-registers a provider's models, instead of dropping it.
  
  The `@gotgenes/pi-permission-system` peer range moves to v37 – v39, which require Pi 1.0. Their breaking changes gate Pi's built-in MCP tools on the `mcp` surface and narrow the Pi infrastructure read bypass, leaving the authorizer surface unchanged.
  
  pi-permission-auto-review reads a project's `.pi/extensions/pi-permission-auto-review/config.json` only once Pi trusts the project, as pi-permission-system does with its own project config, so an untrusted repository cannot swap in a policy that approves everything. `/permission-auto-review` refuses to edit an untrusted project's config, and `show` marks it as ignored.
  
  The reviewer sees the complete input of the tool call that raised the ask instead of pi-permission-system's preview, and the request is no longer truncated: an action too large for the reviewer model defers to the human prompt as `input-budget-exceeded`. Reviews use their own `auto-review:<session id>` session key, so they stop resetting the main conversation's Codex WebSocket continuation.
  
  Interrupting the turn cancels a running review at once and denies the ask, since deferring would open the prompt the user just escaped. A denial carries Codex's instruction against working around it, a malformed reply is retried within the review's budget, the reviewer's output is no longer capped at 1,000 tokens, and every decision logs the tokens it used. The footer shows whether the reviewer is registered and how many asks it allowed, denied or deferred.

## 0.7.0

### Minor Changes

- [`80b4ec9`](https://github.com/mzwing/pi-packages/commit/80b4ec97f3ac978195e01b789f7e9bb54b3ed82a) Thanks [@mzwing](https://github.com/mzwing)! - refactor: clean for a more clear structure, switch to a more modern writing, refine README

## 0.6.0

### Minor Changes

- [`4f31a6f`](https://github.com/mzwing/pi-packages/commit/4f31a6f364eeab49b907940a8dc88bbf9e844f78) Thanks [@mzwing](https://github.com/mzwing)! - feat: adapt to Pi 0.99.1 and accept @gotgenes/pi-permission-system v36

## 0.5.2

### Patch Changes

- [`d6db69c`](https://github.com/mzwing/pi-packages/commit/d6db69ce868cdcb9afa3a9fadb38414814e0ed17) Thanks [@mzwing](https://github.com/mzwing)! - fix(pi-permission-auto-review): pass the session ID on reviewer model calls ([#22](https://github.com/mzwing/pi-packages/issues/22))

## 0.5.1

### Patch Changes

- [`d845495`](https://github.com/mzwing/pi-packages/commit/d845495fb78274f4fc6684e172247891a262995b) Thanks [@mzwing](https://github.com/mzwing)! - chore: accept Pi 0.87 and @gotgenes/pi-permission-system v34 and v35, reconcile the bundled Guardian policy against openai/codex@26cb4d73
  
  pi-model-info now keeps a model's `promptCache` and Pi 0.87's new `inputLimits` when it re-registers a provider's models, instead of dropping both.
  
  `@gotgenes/pi-permission-system` v34 and v35 leave the authorizer surface unchanged: their breaking changes gate a redirect's target against path rules, which authorizers already cannot auto-approve, and stop appending the tool surface to a custom system prompt.
  
  Upstream added an `{{ extra_policy }}` slot for operator policy at the end of the template's security policy (openai/codex#47125). pi-permission-auto-review's `additionalPolicy` now renders in that slot, as `## Operator Policy` ahead of the outcome rules instead of after them, so `POLICY_REVISION` moves to `+pi2`.

## 0.5.0

### Minor Changes

- [`76a551a`](https://github.com/mzwing/pi-packages/commit/76a551a3eb5ba47ef5137407f8a15b1c36f9eab1) Thanks [@mzwing](https://github.com/mzwing)! - feat: adapt to Pi 0.86 and @gotgenes/pi-permission-system v33, reconcile the bundled Guardian policy
  
  The Pi peer range moves to `^0.86.0`. 0.86 replaces the pi-ai provider stream input with a normalized `TranscriptContext` and restricts `ToolCall.arguments` and `ToolResultMessage.details` to JSON values, so these packages are built and tested against that line only.
  
  `Provider.streamSimple()` no longer accepts a system prompt, so pi-permission-auto-review streams reviews through `ModelRegistry.streamSimple()` instead. That facade takes the prompt directly and resolves request-time authentication, so the reviewer no longer fetches an API key itself: an unusable Codex login now logs `provider-error` rather than the removed `auth-unresolved` category, and still defers to the human prompt. Its `@gotgenes/pi-permission-system` peer range narrows to v33, the only line tested against Pi 0.86 — that release's breaking changes are internal MCP rule matching, leaving the authorizer surface unchanged from v32.
  
  The bundled Guardian policy is reconciled against openai/codex@a8c36ca6, which moved `policy_template.md` and `policy.md` from `codex-rs/core/assets/guardian` to `codex-rs/prompts/templates/guardian` (openai/codex#46026). Both files are byte-identical across the move, so the adapted policy text is unchanged; only the tracked directory and the pinned revision recorded in `POLICY_REVISION` move.

## 0.4.0

### Minor Changes

- [`dd4b6ba`](https://github.com/mzwing/pi-packages/commit/dd4b6ba6cdf90ce882b0fe73ba0f8746ebe2e37d) Thanks [@mzwing](https://github.com/mzwing)! - feat(pi-permission-auto-review): export the review pipeline from a ./review subpath

## 0.3.3

### Patch Changes

- [`b5825f8`](https://github.com/mzwing/pi-packages/commit/b5825f84e94b8f2551f8a1cd1643e15c992d53c7) Thanks [@mzwing](https://github.com/mzwing)! - chore(pi-permission-auto-review): accept @gotgenes/pi-permission-system v31 and v32

## 0.3.2

### Patch Changes

- [`35fb0a8`](https://github.com/mzwing/pi-packages/commit/35fb0a8b75708ff0c693293f83e146fbe1e3a0fc) Thanks [@mzwing](https://github.com/mzwing)! - chore(pi-permission-auto-review): accept @gotgenes/pi-permission-system v30, update deps

## 0.3.1

### Patch Changes

- [`125187d`](https://github.com/mzwing/pi-packages/commit/125187d5046cc459280b5bf46e266aee783bd6ec) Thanks [@mzwing](https://github.com/mzwing)! - chore(pi-permission-auto-review): reconcile the bundled Guardian policy against openai/codex@6478a751, accept @gotgenes/pi-permission-system v29
  
  Upstream moved `policy_template.md` and `policy.md` from `codex-rs/core/src/guardian` to `codex-rs/core/assets/guardian` (openai/codex#41477). Both files are byte-identical across the move, so the adapted policy text is unchanged; only the tracked directory and the pinned revision recorded in `POLICY_REVISION` move.
  
  v29.0.0 removes the deprecated process-root service slot — `getRootPermissionsService()` and its publish/unpublish pair. This extension registers through the keyed locator `getPermissionsService(sessionId)`, which that release leaves untouched along with the `PermissionsService` interface, the authorizer contract, and the `permissions:ready` payload, so only the peer range widens.

## 0.3.0

### Minor Changes

- [`52ab334`](https://github.com/mzwing/pi-packages/commit/52ab3344add20a207796bccd40e5d7b836efe7e6) Thanks [@mzwing](https://github.com/mzwing)! - refactor for simpilicity, support for Pi 0.84 and pi-permission-system v27

## 0.2.0

### Minor Changes

- [`162b8f5`](https://github.com/mzwing/pi-packages/commit/162b8f580d76bf043e697a1dd97f172ea9abd7f0) Thanks [@mzwing](https://github.com/mzwing)! - feat(pi-permission-auto-review): sync the latest codex-auto-review prompt, enhance permission reviewer with user interaction handling and transcript statistics

## 0.1.4

### Patch Changes

- [`351bc90`](https://github.com/mzwing/pi-packages/commit/351bc903442cb7e42514b6672290ad7ef4e6750b) Thanks [@mzwing](https://github.com/mzwing)! - Prevent subagent extension instances from repeatedly registering the process-global `auto-review` authorizer.

## 0.1.3

### Patch Changes

- [`32a0e76`](https://github.com/mzwing/pi-packages/commit/32a0e768df3731bc081e54704550712453e5ace8) Thanks [@mzwing](https://github.com/mzwing)! - Add a legacy model registry provider lookup for Pi 0.80.10 and use it in permission auto-review.

- Updated dependencies [[`32a0e76`](https://github.com/mzwing/pi-packages/commit/32a0e768df3731bc081e54704550712453e5ace8)]:
  - @mzwing/pi-polyfill@0.0.1

## 0.1.2

### Patch Changes

- [`7ce3f16`](https://github.com/mzwing/pi-packages/commit/7ce3f16bafc1f23a1f80ec12488935478a59c96a) Thanks [@mzwing](https://github.com/mzwing)! - Use changeset to release, replace self written script

## 0.1.1

### Patch Changes

- No significant changes

## 0.1.0

### Patch Changes

- Initial release
