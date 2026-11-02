---
"@mzwing/pi-permission-auto-review": patch
---

fix(pi-permission-auto-review): stop Claude from refusing the `claude-code` second pass

The second pass asked the reviewer to write its reasoning in `<thinking>` tags in its reply. Claude Sonnet 5.5 and other recent Claude models refuse that as reasoning extraction before answering, so no call the fast pass flagged got a verdict, and each fell to you once the review failed.

The second pass now reasons natively at `reasoning`, which for `claude-code` defaults to `high`, Claude Sonnet's own default effort, instead of `off`. The policy revision becomes `claude-code/2.1.314+pi2`.

`CLAUDE_CODE_THINKING_PROMPT`, exported from `@mzwing/pi-permission-auto-review/review`, no longer asks for written reasoning either, so a request sending it should turn the model's reasoning on.
