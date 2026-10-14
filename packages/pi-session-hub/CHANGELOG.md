# @mzwing/pi-session-hub

## 0.2.2

### Patch Changes

- [`758ce8b`](https://github.com/mzwing/pi-packages/commit/758ce8b72f3734d6521bda4ee4f1bc39716aa316) Thanks [@mzwing](https://github.com/mzwing)! - fix(pi-task-governor): increase pi peer to fix a run that a message started lost the prompt text extensions add in `before_agent_start`
  
  The Pi peer range moves to `^1.2.0`.
  
  Before 1.2.0, a run that a message started lost the prompt text extensions add in `before_agent_start`, so a pi-task-governor coordinator that session-hub mail woke up worked without its role instructions.

## 0.2.1

### Patch Changes

- [`3729f3f`](https://github.com/mzwing/pi-packages/commit/3729f3fb3024d055b0e222efc706523824640d3e) Thanks [@mzwing](https://github.com/mzwing)! - fix(pi-session-hub, pi-task-governor): show session mail when it arrives, not after the user's next message
  
  Mail that does not wake its recipient, and mail waiting when a session starts, went through Pi's `nextTurn` delivery, which keeps a message out of sight until the user sends one. Such mail is now written to the session at once, or when a busy recipient's turn ends, and its model reads it in its next request. Steered mail that Pi drops when a run is stopped in the TUI is written to the session afterwards, without starting a turn.
  
  pi-task-governor's notices that do not wake the coordinator, and the task board that `/governor handoff` puts in the new session, appear the same way.

## 0.2.0

### Minor Changes

- [`6af2cc5`](https://github.com/mzwing/pi-packages/commit/6af2cc59d08ea7dcd455af6123b4a9c68df4d6f4) Thanks [@mzwing](https://github.com/mzwing)! - feat: adapt to Pi 1.1 and jj 0.46, and accept @gotgenes/pi-permission-system v40
  
  The Pi peer range moves to `^1.1.0`, the line these packages are built and tested against.
  
  pi-permission-auto-review accepts `@gotgenes/pi-permission-system` v40, whose breaking change matches a bash rule written with an absolute path against the relative spelling of that path, leaving the authorizer surface unchanged. The spelling a rule matched, which v40 adds to an ask, reaches the reviewer with the rest of the request.
  
  Since Pi 1.0.4, `--tools` no longer removes MCP tools, so pi-task-governor starts its executors with `--no-mcp`: they work with their fixed tool set alone and connect to no MCP servers.
  
  pi-task-governor now requires jj 0.46. That release turns a workspace added to a colocated repository into a Git worktree by default, so task workspaces are added with `--no-colocate` and stay without `.git`, as the task environment and the developer prompt expect.

## 0.1.1

### Patch Changes

- [`fbd2a0a`](https://github.com/mzwing/pi-packages/commit/fbd2a0a156637e20fdb1c9e6d5b4f51d25b97985) Thanks [@mzwing](https://github.com/mzwing)! - chore: prove npmjs.com's connection

## 0.1.0

### Minor Changes

- [`a0c9a99`](https://github.com/mzwing/pi-packages/commit/a0c9a99c39ef57108e0d9b6bd9e95f2dbe0102ba) Thanks [@mzwing](https://github.com/mzwing)! - init(pi-session-hub): init project
