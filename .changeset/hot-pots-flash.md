---
"@mzwing/pi-permission-auto-review": minor
---

feat(pi-permission-auto-review): continue the reviewer's conversation instead of resending the whole transcript

As Codex does, a later ask in a session extends the reviewer's conversation with only what the session added since the last review, so a provider with a prompt cache reads the earlier reviews from it, and an ask beside a tool call reviewed a moment ago sends little more than its own request. The conversation starts over in full when it would overflow the reviewer's context window, when the session moves to another branch, or after a review fails.

`followUpReviews` sets the mode. `auto`, the default, also starts over after a follow-up the provider served without a cache hit, so a provider that does not cache never resends a growing conversation; `always` keeps the conversation then, and `off` sends every review in full. The review log's `priorReviews` counts the reviews a request continued, and `policyRevision` ends in `+pi3`.

`AutoReviewConfig`, exported from `@mzwing/pi-permission-auto-review/review`, now requires `followUpReviews`, which `DEFAULT_CONFIG` includes, and `renderTranscript` takes the index of the first entry to render.
