---
"@mzwing/pi-permission-auto-review": patch
---

fix(pi-permission-auto-review): never resend a request the provider refused

A review retried every failed call, so a request Claude refused went out again up to `maxRetries` times, each time drawing another refusal on the account. A provider error now gets another call only when Pi itself would retry it, such as a rate limit, an overloaded or unavailable provider or a dropped connection. A refusal, or any other error a retry cannot change, such as an unusable login, falls to you at once.
