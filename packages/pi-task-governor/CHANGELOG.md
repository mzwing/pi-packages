# @mzwing/pi-task-governor

## 0.6.0

### Minor Changes

- [`da837db`](https://github.com/mzwing/pi-packages/commit/da837db821f043aef019227f1aaaab46c5d20d36) Thanks [@mzwing](https://github.com/mzwing)! - refactor: group `src/` and `test/` into folders by responsibility
  
  Each package keeps its modules in folders by subsystem instead of side by side in one `src/`, and its tests in matching folders under `test/`. Entry points, exports and config files are unchanged.

- [`9a1a8ef`](https://github.com/mzwing/pi-packages/commit/9a1a8ef5bb95dad8a9cbcc5b915be311eea42d03) Thanks [@mzwing](https://github.com/mzwing)! - feat(pi-task-governor): land each task as one commit with a message the coordinator writes
  
  A task's work stays one commit without a message while it is worked, instead of one commit per developer run titled with the task id and carrying the developer's report. It merges with the message the coordinator gives `task_approve`, following the user's commit message skill or instructions, else the repository's convention or Conventional Commits.
  
  A task whose rebase onto the bookmark conflicts keeps the rebase, conflict markers included, for its executor to resolve. Before, the merge commit left in its workspace kept the executor from developing or reviewing the task, and broke the sign-off requests of other tasks on the same bookmark.

### Patch Changes

- [`2267bf4`](https://github.com/mzwing/pi-packages/commit/2267bf483c6647ef187caba736770fb3c5b0a889) Thanks [@mzwing](https://github.com/mzwing)! - chore: accept Pi 1.4 and @gotgenes/pi-permission-system v42
  
  The Pi peer range moves to `^1.4.0`, the line these packages are built and tested against. From 1.4.0 on, resuming a session that began before pi-session-hub was installed, `session_spawn`'s `resume` included, activates the hub's tools instead of leaving them off.
  
  pi-permission-auto-review accepts `@gotgenes/pi-permission-system` v42, whose only breaking change, a limit of 1,000 entries on each of its config arrays, does not affect the reviewer.

- [`4471e84`](https://github.com/mzwing/pi-packages/commit/4471e840317511541fa02c3d8b59eb7f89a44c79) Thanks [@mzwing](https://github.com/mzwing)! - fix: validate configs with valibot instead of zod
  
  pi-codex-downgrade-detector, pi-model-info, pi-permission-auto-review and pi-task-governor no longer depend on zod: they validate their config with valibot, bundled into each package, so installing one adds nothing beyond its peer dependencies. Config errors follow valibot's wording, and an unknown key is reported at its own path, as in `reasonning: Invalid key: Expected never but received "reasonning"`.
  
  pi-model-info reports a rule id or a source given twice against the file that repeats it. Before, it named the project's config file wherever the repeat was.
- Updated dependencies [[`2267bf4`](https://github.com/mzwing/pi-packages/commit/2267bf483c6647ef187caba736770fb3c5b0a889), [`da837db`](https://github.com/mzwing/pi-packages/commit/da837db821f043aef019227f1aaaab46c5d20d36)]:
  - @mzwing/pi-session-hub@0.4.0

## 0.5.0

### Minor Changes

- [`b8fb3f5`](https://github.com/mzwing/pi-packages/commit/b8fb3f544038e7adbd1b87b09a41822b19ccc9a4) Thanks [@mzwing](https://github.com/mzwing)! - feat(pi-task-governor): let the coordinator revise a task's brief
  
  `task_revise` rewrites the parts of a brief it is given, for a task no executor is working on: a root task that waits to start or for its sign-off, or a task whose executor waits for the coordinator's answer or stalled. A task left waiting for an answer goes on in a fresh executor session on the new brief, and one waiting for its sign-off goes back to be reviewed against it.

- [`ae40b3b`](https://github.com/mzwing/pi-packages/commit/ae40b3b3da0d34d2ba1f92f813bc2ab243e950ef) Thanks [@mzwing](https://github.com/mzwing)! - feat(pi-task-governor): show the coordinator the tasks that overlap and the tasks that wait when it signs a task off
  
  The sign-off request lists the other tasks of the same bookmark that change files the task changes, both those merged since it started and those still open, and the declared tasks that wait for it, whose briefs the coordinator can revise before they start.

- [`3f58971`](https://github.com/mzwing/pi-packages/commit/3f58971628d1b6fba22db21ea3ba5f453a70dd52) Thanks [@mzwing](https://github.com/mzwing)! - feat(pi-task-governor): bring a task back to the coordinator when its reviews keep failing or its sessions run on
  
  A task whose review fails three times in a row asks the coordinator how to go on, and its executor stops until the answer comes. Between the coordinator's words on a task, which are its answers, revised briefs, approvals and refusals, the task gets three executor sessions, and it stalls once the third ends, whether that session stopped early or handed off. Before, only sessions that stopped early counted, so a task whose sessions kept handing off ran on without the coordinator hearing of it.

### Patch Changes

- [`386b523`](https://github.com/mzwing/pi-packages/commit/386b523873f189bad5c8a95b2c81b7996fd3784b) Thanks [@mzwing](https://github.com/mzwing)! - chore: accept Pi 1.3 and @gotgenes/pi-permission-system v41
  
  The Pi peer range moves to `^1.3.0`, the line these packages are built and tested against. From 1.3.0 on, a session that pi-session-hub's `session_spawn` continues with `resume` keeps its active tools instead of falling back to the default ones.
  
  pi-permission-auto-review accepts `@gotgenes/pi-permission-system` v41. Where v40 downgrades the reviewer's `allow` on every `path` and `external_directory` ask to `defer`, v41 lets it stand on a bash `external_directory` ask whose paths name nothing on disk, such as the spreadsheet cell in `officecli set data.xlsx /Sheet1/B1`. The license that marks such an ask reaches the reviewer with the rest of the request.
- Updated dependencies [[`386b523`](https://github.com/mzwing/pi-packages/commit/386b523873f189bad5c8a95b2c81b7996fd3784b)]:
  - @mzwing/pi-session-hub@0.3.1

## 0.4.0

### Minor Changes

- [`ca2237f`](https://github.com/mzwing/pi-packages/commit/ca2237f936946c535520ef45a952e593c64dc451) Thanks [@mzwing](https://github.com/mzwing)! - feat(pi-task-governor): work each task in fresh executor sessions instead of resuming one
  
  A fresh executor session takes over whenever the last one hands off with `task_handoff`, reaches `roles.executor.maxTurns` turns, gets the coordinator's answer, or stops early. It starts from the task board, the task's latest events and the note the executor keeps on it with `task_note`, and can read the sessions before it with `session_read`.
  
  After upgrading, run `/governor coordinate` again in the coordinating session, so the config its store keeps gains the turn limits of the coordinator and the executor.

- [`3093b7d`](https://github.com/mzwing/pi-packages/commit/3093b7df0d18854a1402278d610536d1f096c3e7) Thanks [@mzwing](https://github.com/mzwing)! - feat(pi-session-hub, pi-task-governor): give each task its own `TMPDIR`
  
  A task's executor, developers, reviewers, checks and setup commands use a temporary directory beside its workspace, which is removed with the workspace. For this, pi-session-hub's `spawnSession` takes `env`, variables set in the new session's environment over the ones it inherits.

- [`ed5e055`](https://github.com/mzwing/pi-packages/commit/ed5e055292f8bf64bdc9fe0ffc6641f9571ca281) Thanks [@mzwing](https://github.com/mzwing)! - feat(pi-task-governor)!: require the coordinator's sign-off before a reviewed task merges
  
  A root task that passes its review now waits for the coordinator, which receives the change, its reviewer's evidence for every criterion and the executor's note, and approves the task with `task_approve` or sends it back with findings through `task_reject`. Approved tasks merge one at a time from the coordinator, re-running their checks after a rebase; a task sent back, or whose merge conflicts or breaks a check, goes to a fresh executor session. Only the merge that finishes the last task wakes the coordinator, to report the outcome.
  
  BREAKING CHANGE: a reviewed root task no longer merges on its own. It merges once the coordinator approves it, from the coordinator's session, so reviewed tasks wait while no coordinator runs.

- [`9400b19`](https://github.com/mzwing/pi-packages/commit/9400b1952cc2595e21162b3cac96f5069ba66f21) Thanks [@mzwing](https://github.com/mzwing)! - feat(pi-task-governor): let a task wait for other tasks to merge before it starts
  
  `task_declare` takes `after`, the root tasks of the same bookmark that must be merged first, so the coordinator can plan a whole change and declare it at once. Each task starts as soon as the tasks it waits for are merged, and cancelling a task cancels the tasks waiting for it.

### Patch Changes

- [`22df74c`](https://github.com/mzwing/pi-packages/commit/22df74cda616ebaf364460008d356cb85b485ffd) Thanks [@mzwing](https://github.com/mzwing)! - fix(pi-task-governor): show the coordinator's handoff reminder when another extension owns compaction
  
  The reminder to run `/governor handoff` counted compactions, which never happen once an extension such as pi-magic-context takes compaction over. It now comes after `roles.coordinator.maxTurns` turns, and the session `/governor handoff` opens learns which session it took over from, to read with `session_read`.
- Updated dependencies [[`3093b7d`](https://github.com/mzwing/pi-packages/commit/3093b7df0d18854a1402278d610536d1f096c3e7)]:
  - @mzwing/pi-session-hub@0.3.0

## 0.3.1

### Patch Changes

- [`758ce8b`](https://github.com/mzwing/pi-packages/commit/758ce8b72f3734d6521bda4ee4f1bc39716aa316) Thanks [@mzwing](https://github.com/mzwing)! - fix(pi-task-governor): increase pi peer to fix a run that a message started lost the prompt text extensions add in `before_agent_start`
  
  The Pi peer range moves to `^1.2.0`.
  
  Before 1.2.0, a run that a message started lost the prompt text extensions add in `before_agent_start`, so a pi-task-governor coordinator that session-hub mail woke up worked without its role instructions.
- Updated dependencies [[`758ce8b`](https://github.com/mzwing/pi-packages/commit/758ce8b72f3734d6521bda4ee4f1bc39716aa316)]:
  - @mzwing/pi-session-hub@0.2.2

## 0.3.0

### Minor Changes

- [`63a62b9`](https://github.com/mzwing/pi-packages/commit/63a62b9d614d78b52d8e348d128ee22e081d811d) Thanks [@mzwing](https://github.com/mzwing)! - fix(pi-task-governor): remove regex based path matching disabling commands
  
  The coordinator is the user's own session in the main workspace, so its bash runs `git`, `jj` and `pi` like any other command, and `/governor unlock` there says it has nothing to lift. Other governed sessions still find them blocked by the shims on PATH, but their commands are no longer matched as text against paths to the binaries, `nix run`, and `.git` or `.jj`, which refused harmless commands such as `grep --exclude-dir=.git` and `ls packages/pi`.

### Patch Changes

- [`3729f3f`](https://github.com/mzwing/pi-packages/commit/3729f3fb3024d055b0e222efc706523824640d3e) Thanks [@mzwing](https://github.com/mzwing)! - fix(pi-session-hub, pi-task-governor): show session mail when it arrives, not after the user's next message
  
  Mail that does not wake its recipient, and mail waiting when a session starts, went through Pi's `nextTurn` delivery, which keeps a message out of sight until the user sends one. Such mail is now written to the session at once, or when a busy recipient's turn ends, and its model reads it in its next request. Steered mail that Pi drops when a run is stopped in the TUI is written to the session afterwards, without starting a turn.
  
  pi-task-governor's notices that do not wake the coordinator, and the task board that `/governor handoff` puts in the new session, appear the same way.
- Updated dependencies [[`3729f3f`](https://github.com/mzwing/pi-packages/commit/3729f3fb3024d055b0e222efc706523824640d3e)]:
  - @mzwing/pi-session-hub@0.2.1

## 0.2.0

### Minor Changes

- [`6af2cc5`](https://github.com/mzwing/pi-packages/commit/6af2cc59d08ea7dcd455af6123b4a9c68df4d6f4) Thanks [@mzwing](https://github.com/mzwing)! - feat: adapt to Pi 1.1 and jj 0.46, and accept @gotgenes/pi-permission-system v40
  
  The Pi peer range moves to `^1.1.0`, the line these packages are built and tested against.
  
  pi-permission-auto-review accepts `@gotgenes/pi-permission-system` v40, whose breaking change matches a bash rule written with an absolute path against the relative spelling of that path, leaving the authorizer surface unchanged. The spelling a rule matched, which v40 adds to an ask, reaches the reviewer with the rest of the request.
  
  Since Pi 1.0.4, `--tools` no longer removes MCP tools, so pi-task-governor starts its executors with `--no-mcp`: they work with their fixed tool set alone and connect to no MCP servers.
  
  pi-task-governor now requires jj 0.46. That release turns a workspace added to a colocated repository into a Git worktree by default, so task workspaces are added with `--no-colocate` and stay without `.git`, as the task environment and the developer prompt expect.

### Patch Changes

- Updated dependencies [[`6af2cc5`](https://github.com/mzwing/pi-packages/commit/6af2cc59d08ea7dcd455af6123b4a9c68df4d6f4)]:
  - @mzwing/pi-session-hub@0.2.0

## 0.1.1

### Patch Changes

- [`fbd2a0a`](https://github.com/mzwing/pi-packages/commit/fbd2a0a156637e20fdb1c9e6d5b4f51d25b97985) Thanks [@mzwing](https://github.com/mzwing)! - chore: prove npmjs.com's connection
- Updated dependencies [[`fbd2a0a`](https://github.com/mzwing/pi-packages/commit/fbd2a0a156637e20fdb1c9e6d5b4f51d25b97985)]:
  - @mzwing/pi-session-hub@0.1.1

## 0.1.0

### Minor Changes

- [`a0c9a99`](https://github.com/mzwing/pi-packages/commit/a0c9a99c39ef57108e0d9b6bd9e95f2dbe0102ba) Thanks [@mzwing](https://github.com/mzwing)! - init(pi-task-governor): init project

### Patch Changes

- Updated dependencies [[`a0c9a99`](https://github.com/mzwing/pi-packages/commit/a0c9a99c39ef57108e0d9b6bd9e95f2dbe0102ba)]:
  - @mzwing/pi-session-hub@0.1.0
