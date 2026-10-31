---
"@mzwing/pi-permission-auto-review": minor
---

pr: #34

feat(pi-permission-auto-review): configure review retries and a time limit for each call

`maxRetries` sets how many times a review retries a call that fails or returns a malformed reply, from 0 to 20 and 2 by default. `attemptTimeoutMs` abandons a call that runs longer and retries it like a failed one; without it, a call can run until `timeoutMs` ends the review. The pause between retries grows from 250 ms to at most 30 seconds, and the calls and pauses together stay within `timeoutMs`.

`AutoReviewConfig`, exported from `@mzwing/pi-permission-auto-review/review`, now requires `maxRetries`, which `DEFAULT_CONFIG` includes.
