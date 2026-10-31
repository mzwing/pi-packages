---
"@mzwing/pi-codex-downgrade-detector": minor
"@mzwing/pi-model-info": minor
"@mzwing/pi-permission-auto-review": minor
"@mzwing/pi-session-hub": minor
"@mzwing/pi-task-governor": minor
---

refactor: group `src/` and `test/` into folders by responsibility

Each package keeps its modules in folders by subsystem instead of side by side in one `src/`, and its tests in matching folders under `test/`. Entry points, exports and config files are unchanged.
