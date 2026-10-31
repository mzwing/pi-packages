---
"@mzwing/pi-codex-downgrade-detector": patch
"@mzwing/pi-model-info": patch
"@mzwing/pi-permission-auto-review": patch
"@mzwing/pi-session-hub": patch
"@mzwing/pi-task-governor": patch
---

chore: accept Pi 1.4 and @gotgenes/pi-permission-system v42

The Pi peer range moves to `^1.4.0`, the line these packages are built and tested against. From 1.4.0 on, resuming a session that began before pi-session-hub was installed, `session_spawn`'s `resume` included, activates the hub's tools instead of leaving them off.

pi-permission-auto-review accepts `@gotgenes/pi-permission-system` v42, whose only breaking change, a limit of 1,000 entries on each of its config arrays, does not affect the reviewer.
