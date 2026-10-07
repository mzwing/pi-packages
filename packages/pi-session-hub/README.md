# @mzwing/pi-session-hub

[![npm](https://img.shields.io/npm/v/@mzwing/pi-session-hub)](https://www.npmjs.com/package/@mzwing/pi-session-hub)

A [Pi](https://github.com/earendil-works/pi) extension that lets the Pi sessions on one machine find, read and message each other, and start independent headless sessions.

## Install

```bash
pi install npm:@mzwing/pi-session-hub
```

Requires Pi 1.0.0 or later.

## Usage

The model gets four tools:

| Tool            | What it does                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `session_list`  | Lists the running sessions on this machine and the recent sessions of this project                      |
| `session_read`  | Shows another session's conversation as its model sees it                                               |
| `session_send`  | Messages a running session, starting a turn there unless `wake` is false                                |
| `session_spawn` | Starts a headless `pi --print` session that outlives this one, or continues a stopped one with `resume` |

`/sessions` shows the same list as `session_list`, and `/sessions <id>` a session's transcript.

Messages wait in a queue under `~/.pi/agent/pi-session-hub/`, so one that reaches a headless session after its run has ended is read when that session next starts. A spawned session writes its output to `~/.pi/agent/pi-session-hub/logs/<id>.log`.

A spawned session runs headless, so [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system) denies whatever would ask. Give it rules without asks, or add [`@mzwing/pi-permission-auto-review`](https://www.npmjs.com/package/@mzwing/pi-permission-auto-review) to the authorizer chain.

## Programmatic use

Other extensions message and start sessions through `@mzwing/pi-session-hub/api`, whose exports are listed in [`src/api.ts`](./src/api.ts).

## Credits

Spawned sessions re-invoke Pi the way `getPiInvocation` does in Pi's [subagent example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts).

## License

[MIT](LICENSE)
