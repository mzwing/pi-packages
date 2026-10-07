# @mzwing/pi-task-governor

[![npm](https://img.shields.io/npm/v/@mzwing/pi-task-governor)](https://www.npmjs.com/package/@mzwing/pi-task-governor)

A [Pi](https://github.com/earendil-works/pi) extension that works a [jj](https://github.com/jj-vcs/jj) repository through declared tasks. You talk to one coordinator session, which writes each task down with its problem, scope, boundary, non-goals and acceptance criteria. A headless executor session then works the task in a jj workspace of its own through developer and reviewer subagents, and the task merges only once a fresh reviewer has signed off every criterion with evidence.

## Install

```bash
pi install npm:@mzwing/pi-session-hub
pi install npm:@mzwing/pi-task-governor
```

Requires Pi 1.0.0 or later and jj 0.45 or later. A repository with an `.envrc` also needs direnv, and one with only a `flake.nix` needs Nix.

## Usage

Run `/governor coordinate` in the main workspace of a jj repository. That session becomes the coordinator: tell it what you want, and it declares the tasks. From then on:

- Up to `maxExecutors` tasks are worked at once, each in its own workspace and inside the environment of the repository's `.envrc` or `flake.nix`.
- An executor that needs a decision asks the coordinator and is restarted with the answer. One that stops before its task ends is restarted a few times, then reported as stalled.
- A task that runs into a separate problem opens a subtask and finishes it first; a task is reviewed only after its subtasks.
- A signed-off task merges into the bookmark it was declared against, which only ever moves forward. A merge that conflicts goes back to the executor to resolve and review again. The workspace of a finished task is removed.

Governed sessions cannot run `git`, `jj` or `pi`, the coordinator works without Pi's edit and write tools and without pi-subagents' agents, and the session that declared or worked a task cannot sign it off. These rules stop a model's habits and slips, not one set on getting around them.

`/governor` shows the task tree. `/governor pause` and `/governor resume` stop and restart launching executors, `/governor unlock [minutes]` lifts the `git`, `jj` and `pi` block in the current session for 30 minutes or the given number (`0` restores it), and `/governor handoff` continues coordinating in a fresh session. These commands work only in Pi's interactive TUI.

Tasks are kept in `.jj/pi-task-governor/` inside the repository, out of version control.

With [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system), what would ask in an executor or in its developers and reviewers goes to the coordinator, which answers through its authorizer chain, such as [`@mzwing/pi-permission-auto-review`](https://www.npmjs.com/package/@mzwing/pi-permission-auto-review), or by asking you. While the coordinator is not running, such asks are denied.

## Configuration

Optional. `~/.pi/agent/extensions/pi-task-governor/config.json` and `.pi/extensions/pi-task-governor/config.json` are merged, the project over the global one and role by role; the project file is read only once Pi trusts the project. The config is read when `/governor coordinate` runs, and executors use the copy saved then.

| Field                       | Default        | Description                                                                                         |
| --------------------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| `workspaceRoot`             | `<repo>.tasks` | Where task workspaces go, relative to the repository                                                |
| `maxExecutors`              | `3`            | Tasks worked at once                                                                                |
| `defaultBookmark`           | `main`         | Bookmark a task branches from and merges into, unless it names another                              |
| `roles.<role>.model`        | —              | `provider/id` for the `executor`, `developer` or `reviewer` role                                    |
| `roles.<role>.thinking`     | —              | Thinking level of that role                                                                         |
| `roles.<role>.instructions` | —              | Added to the built-in instructions of the `coordinator`, `executor`, `developer` or `reviewer` role |
| `roles.developer.maxTurns`  | `100`          | Turns a developer gets                                                                              |
| `roles.reviewer.maxTurns`   | `40`           | Turns a reviewer gets                                                                               |
| `env.provider`              | `auto`         | `direnv`, `flake` or `none`; `auto` picks direnv for an `.envrc`, then a flake                      |
| `env.setup`                 | `[]`           | Commands run once in each new workspace, such as `pnpm install --frozen-lockfile`                   |
| `globalChecks`              | `[]`           | `{ statement, check }` criteria added to every task                                                 |

See the [example config](./config/config.example.json) and the [JSON Schema](./schemas/config.schema.json) for every option.

## Credits

Super thanks <https://t.me/im_RORIRI/34988> for the idea of the roles! Without the outstanding idea, this package would not exist.

Developer and reviewer sessions inherit the providers extensions registered at runtime the way [`@gotgenes/pi-subagents`](https://github.com/gotgenes/pi-packages/blob/main/packages/pi-subagents/src/session/provider-inheritance.ts) does.

## License

[MIT](LICENSE)
