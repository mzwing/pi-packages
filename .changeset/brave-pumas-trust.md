---
"@mzwing/pi-codex-downgrade-detector": patch
"@mzwing/pi-model-info": patch
"@mzwing/pi-permission-auto-review": patch
"@mzwing/pi-session-hub": patch
"@mzwing/pi-task-governor": patch
---

chore: accept Pi 1.5

The Pi peer range moves to `^1.5.0`, the line these packages are built and tested against. From 1.5.0 on, a saved "Do not trust" decision for a project or a parent folder also holds when the project has no `.pi/` resources or `.agents/skills` of its own, so pi-permission-auto-review leaves that project's `AGENTS.md` and `CLAUDE.md` out of the review and keeps only your global `AGENTS.md`, instead of passing them to the reviewer where a cloned repository could vouch for its own actions.

Each package now includes its `CHANGELOG.md` in the published npm package, which earlier releases left out. From 1.5.0 on, Pi reads a package's changelog and, on the first fresh launch after an update such as `pi update`, shows the entries newer than your previous version under "Extension Updates". Because Pi starts tracking a package's version only once the installed release ships a changelog, it records this release without showing anything and shows the notes from the next update on.
