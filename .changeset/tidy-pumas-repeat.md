---
'@mzwing/pi-permission-auto-review': patch
---

chore(pi-permission-auto-review): reconcile the bundled Guardian policy against openai/codex@6478a751, accept @gotgenes/pi-permission-system v29

Upstream moved `policy_template.md` and `policy.md` from `codex-rs/core/src/guardian` to `codex-rs/core/assets/guardian` (openai/codex#41477). Both files are byte-identical across the move, so the adapted policy text is unchanged; only the tracked directory and the pinned revision recorded in `POLICY_REVISION` move.

v29.0.0 removes the deprecated process-root service slot — `getRootPermissionsService()` and its publish/unpublish pair. This extension registers through the keyed locator `getPermissionsService(sessionId)`, which that release leaves untouched along with the `PermissionsService` interface, the authorizer contract, and the `permissions:ready` payload, so only the peer range widens.
