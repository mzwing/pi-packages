---
"@mzwing/pi-permission-auto-review": patch
---

fix(pi-permission-auto-review): log review usage under keys the review log does not mask

pi-permission-system masks every logged value whose key names a token or an authorization, so the review log showed `[redacted]` for `inputTokens`, `cacheReadTokens`, `outputTokens` and `userAuthorization`. A decision now logs `usage` with `input`, `cacheRead` and `output`, and the reviewer's authorization grade as `userApproval`.
