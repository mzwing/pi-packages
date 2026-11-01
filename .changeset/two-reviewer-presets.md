---
"@mzwing/pi-permission-auto-review": major
---

feat(pi-permission-auto-review): add Claude Code auto mode prompt preset, support more accurate control options

`preset` picks the reviewer. `codex`, the default, keeps the Codex Guardian review. `claude-code` follows Claude Code's auto mode, on `anthropic`/`claude-sonnet-5` by default: a short first pass lets only clearly safe actions through, and a second pass that reasons first decides the rest, over a transcript of the user's messages and the agent's calls without their output. Its prompt and rules are written for Pi, not copied from Claude Code. It hands the third denial in a row, and the twentieth in total, to the human prompt, and it shows the reviewer the user's AGENTS.md and CLAUDE.md, a project's own only once Pi trusts the project. `/permission-auto-review defaults` lists the active preset's built-in rules.

Both presets take their rules from `autoMode`, whose `environment`, `allow`, `soft_deny` and `hard_deny` lists match Claude Code's `autoMode` settings. The entry `"$defaults"` stands for the preset's built-in rules, a list without it replaces them, and a project's list replaces only the global list of its name. `autoMode` replaces `includeBaselinePolicy` and `additionalPolicy`, so a config that still sets either fails validation until it is migrated:

- The text of `additionalPolicy` becomes an entry beside `"$defaults"` in `autoMode.soft_deny`, in `autoMode.hard_deny` for a rule no approval may lift, or in `autoMode.allow` for an exception.
- `"includeBaselinePolicy": false` becomes `soft_deny` and `allow` lists without `"$defaults"`. The Guardian policy's authorization scoring, risk taxonomy and outcome rules stay.

Follow-up reviews work under both presets, and a conversation also starts over once it would pass 256k tokens, so a model with a larger context window does not reread an ever longer one.

`AutoReviewConfig`, exported from `@mzwing/pi-permission-auto-review/review`, gains `preset` and `autoMode` and loses `includeBaselinePolicy` and `additionalPolicy`. The subpath also exports the `claude-code` pipeline, under names such as `buildClaudeCodeSystemPrompt` and `parseClaudeCodeVerdict`.
