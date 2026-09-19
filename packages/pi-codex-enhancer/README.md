# @mzwing/pi-codex-enhancer

[![npm](https://img.shields.io/npm/v/@mzwing/pi-codex-enhancer)](https://www.npmjs.com/package/@mzwing/pi-codex-enhancer)

Keeps a valid Codex turn state on every [Pi](https://pi.dev) request, so ChatGPT accounts stay off
the degraded scheduling path.

The ChatGPT Codex backend mints an opaque blob into the `x-codex-turn-state` response header. A
non-degraded one is exactly 292 characters long; carrying it on your next request is what keeps the
answers full-strength instead of the broken-logic, `overloaded`, 429 version. Pi never sends that
header, so every turn starts from nothing. This mints one, holds it for its hour, puts it on each
Codex request, and drops it the moment the server hands back a degraded one:

```
✓ codex+ 292 · 47m left   a valid state is going out on every request
… codex+ minting          a state is being minted right now
⚠ codex+ degraded         the server sent a short state; it was dropped and will be re-minted
? codex+ no state         nothing could be minted, and the request went out bare
· codex+ not gated        this model does not use a turn state
```

Requests are never blocked: no state just means no header.

## Install

```bash
pi install npm:@mzwing/pi-codex-enhancer
```

Then set `"transport": "sse"` in pi's `settings.json` — see [Limits](#limits).

## Configuration

Optional. Both scopes are merged, project over global.

| Scope   | Path                                                   |
| ------- | ------------------------------------------------------ |
| Global  | `~/.pi/agent/extensions/pi-codex-enhancer/config.json` |
| Project | `.pi/extensions/pi-codex-enhancer/config.json`         |

| Field                | Default            | Description                                                                        |
| -------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| `enabled`            | `true`             | Turn the whole thing off.                                                          |
| `providers`          | `["openai-codex"]` | Provider ids to act on. `[]` acts on every provider that speaks the Codex api.     |
| `probeTimeoutMs`     | `8000`             | How long one request may be held while a state is minted. 1000-30000.              |
| `minProbeIntervalMs` | `60000`            | Floor between mints, so a failing account cannot tax every request. 10000-3600000. |
| `probeProxyUrl`      | `""`               | Egress for the mint only. `http`, `https`, `socks5` or `socks5h`; host, no path.   |
| `notify`             | `true`             | Raise a notification on a degraded state, a failed mint, or the wrong transport.   |

Whether a 292 is issued at all seems to depend on the egress IP. `probeProxyUrl` exists for that:
point it at a residential or native-IPv6 exit and only the mint goes through it, while your normal
requests keep pi's usual network path. Tickets are stored at
`~/.pi/agent/extensions/pi-codex-enhancer/tickets.json`, owner-readable only, and shared across
concurrent pi sessions so they mint once between them.

## /codex-enhancer

`/codex-enhancer` prints the held state, the resolved config and where everything was read from.
`/codex-enhancer refresh` mints a new state now, ignoring the interval. `/codex-enhancer forget`
drops the stored one, which is what you want after logging in as a different account.

## Limits

**Set `"transport": "sse"`.** Pi's default `auto` prefers WebSocket, and it pools sockets — the
injected header only reaches the backend on a fresh handshake, so most requests on that transport go
out without it. The extension says so once per session rather than pretending to protect you.

Each mint is a real one-token Codex request and costs a little quota — roughly one an hour. On the
SSE transport the state is usually captured off a real response instead, for free.

Nothing here can make the backend issue a 292. Egress IP, account tier and upstream load all appear
to matter and none of them are ours to set; `no state` means it did not happen, not that something
broke. And the whole mechanism is undocumented: OpenAI can change or drop it at any time.

The state is never printed, only described by length.

## Credits

<https://blog.caowo.de/posts/chatgpt-codex-292-state-anti-degradation-2026/> for writing up the
mechanism, and [sub2api@49a39b6](https://github.com/Wei-Shaw/sub2api/tree/49a39b6dc1abed30fd227611e8af1108bc427610)
for the implementation that pinned down what a good state actually looks like.

## License

[MIT](LICENSE)
