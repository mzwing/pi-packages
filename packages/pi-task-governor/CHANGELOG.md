# @mzwing/pi-task-governor

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
