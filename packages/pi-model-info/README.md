# @mzwing/pi-model-info

[![npm](https://img.shields.io/npm/v/@mzwing/pi-model-info)](https://www.npmjs.com/package/@mzwing/pi-model-info)

Completes third-party model metadata in [Pi](https://pi.dev) from the pi.dev and models.dev
catalogs.

## The problem

Pi only knows the models in its own catalog. Point it at a relay, gateway, or any provider it
has not indexed, and every model gets placeholders instead of metadata:

```
reasoning: false   input: ["text"]   cost: {0,0,0,0}   contextWindow: 128000   maxTokens: 16384
```

That means wrong compaction timing, `$0.00` cost accounting, and reasoning models Pi does not
know are reasoning models. The alternative is hand-writing every field into `models.json`
`modelOverrides` and re-editing it whenever anything changes upstream.

This extension looks each model up in two catalogs and fills the gaps at runtime.

## What it does not do

It never creates providers, never discovers models, never changes `id` / `provider` / `baseUrl` /
`api` / auth / transport, and never writes to any of your files. Where it wraps a provider it
delegates that provider's own auth, transport and refresh behaviour untouched. Remove it and Pi
goes back to exactly what it did before.

## Install

```bash
pi install npm:@mzwing/pi-model-info
```

Then opt a provider in — nothing happens until you do:

```jsonc
// ~/.pi/agent/extensions/pi-model-info/config.json
{ "providers": { "my-relay": {} } }
```

## Staying current

Model lists move. Pi refreshes every built-in provider's catalog from pi.dev on a four-hour clock
and again the moment you open `/model`, and a discovery extension may refetch its own list. A
completion that was snapshotted once does not survive any of that, so it is applied in whichever of
three ways claims the least:

| What Pi already holds for the provider                 | How it is completed                                             | How current the list stays                                            |
| ------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| Nothing else registered, and it refreshes its own list | the provider object is wrapped; `getModels()` completes on read | live — a model that appears mid-session is completed on first read    |
| A sibling extension registered `refreshModels`         | that hook is wrapped, so each refresh returns a completed list  | live — `/model` renders the completion in the refresh that fetched it |
| Anything else                                          | the list is snapshotted and re-registered                       | fixed for the session, re-checked on each agent turn                  |

`/model-info` names which one is in force, per provider.

Only the third row can freeze a dynamic list, and it is the only one that warns. It is reached when
something else owns the provider's registration slot — Pi merges every extension registration for a
provider into one entry, and taking that entry over would take the sibling's `apiKey` with it — or
when models.json defines the provider's `models[]`, which Pi rebuilds above anything underneath.

## Pairing with a discovery extension

If your provider's models come from something like
[`pi-openai-api-models-sync`](https://www.npmjs.com/package/pi-openai-api-models-sync) — a
`models.json` provider with `"models": []` whose real list is fetched from `/v1/models` — the two
extensions are designed to work together: **that one discovers _which_ models exist, this one
completes _what they are_.**

Ordering is guaranteed, not lucky. Discovery extensions register from inside their factory, which
Pi flushes before any session event; this extension registers from `session_start`, strictly
after. It only ever sends `models` — plus, for a sibling that refreshes, a wrapper around that
sibling's own `refreshModels` — so Pi's merge preserves its `baseUrl`, `api`, and `apiKey`, and it
never calls `unregisterProvider` on a registration carrying keys it did not write, because that
call would take those credentials with it.

Where the sibling already supplied a real value and the catalogs cannot resolve the model, its
value is kept byte-for-byte. Where you prefer its numbers even when a catalog does resolve, set
`contextWindowPolicy` / `costPolicy` / `capabilityPolicy` to `"keep"`.

## Sources

| Source                   | Contents                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `pi.dev/api/models`      | Already in Pi's own model shape: cost, limits, capabilities, `thinkingLevelMap`, `compat`. The only source of pricing.                    |
| `models.dev/models.json` | Provider-agnostic limits and capabilities for models pi.dev does not carry, and the vendor oracle used to break ties. Carries no pricing. |

Both are cached on disk under `~/.pi/agent/extensions/pi-model-info/cache/`, revalidated with
`If-None-Match`, and served stale if a fetch fails. Nothing is fetched on Pi's startup path.

`models.dev/api.json` — the 4.2 MB per-provider catalog — is deliberately not used. Where cost
cannot be resolved it is left alone: Pi's `0` reads as "unknown", while a guessed price reads as
fact.

## How a model is matched

```
explicit alias
  ↓
the original id, exactly as your provider spells it
  ↓
the id with at most one prefix and one suffix removed
  ↓
unresolved — nothing is changed
```

The original id is always tried first because catalogs really do carry `:free` and `-free` as
separate entries with their own pricing.

When one id exists under several catalog providers, the winner is chosen in a fixed order — a
`catalogProvider` you configured, then the provider id itself, then the vendor named in the id,
then models.dev's collision-free vendor index. If none of those decides, the model stays
unresolved and `/model-info` lists the candidates so you can add an alias. There is no fuzzy
matching and no model involved.

## Configuration

Global at `~/.pi/agent/extensions/pi-model-info/config.json`, per-project at
`.pi/extensions/pi-model-info/config.json`; the project scope wins. See
[`config/config.example.json`](./config/config.example.json) and
[`schemas/config.schema.json`](./schemas/config.schema.json).

### Per provider

| Key                   | Default   | Meaning                                                                               |
| --------------------- | --------- | ------------------------------------------------------------------------------------- |
| `catalogProvider`     | —         | Scope lookups to one catalog provider, e.g. `openrouter`.                             |
| `costMultiplier`      | `1`       | Relay markup, applied to catalog pricing only — never to a rule's explicit `0`.       |
| `costPolicy`          | `catalog` | `zero` to force free, `keep` to leave pricing alone.                                  |
| `contextWindowPolicy` | `catalog` | `min` never raises the limit past what Pi already had; `keep` leaves limits alone.    |
| `capabilityPolicy`    | `catalog` | `widen` only ever adds a capability; `keep` leaves them alone.                        |
| `useCatalogName`      | `false`   | Rename models to their catalog names.                                                 |
| `mapThinkingLevels`   | `false`   | Derive a thinking-level map from models.dev. pi.dev's real map is always used.        |
| `allowDynamic`        | `false`   | Suppress the warning when a refreshing provider can only be completed by replacement. |
| `models`              | —         | Per-model gates: `alias`, `override`, `skip`, `prefixes`, `suffixes`.                 |

`contextWindowPolicy: "min"` and `capabilityPolicy: "keep"` exist because inflating a limit or
promoting a capability the relay does not actually support turns into a failed request rather
than a bad estimate.

### Rules

`-free` and `:free` are built in and set the cost to zero. Add your own:

```jsonc
{
  "rules": [
    {
      "id": "mainfei",
      "kind": "suffix",
      "value": "-mainfei",
      "override": { "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } },
    },
  ],
}
```

A rule's `override` applies only when that rule was actually used for the match. Rules are tried
longest value first, and single strips before double strips.

Per model, `suffixes` unset means every rule, `[]` means none, and `["mainfei"]` means only that
one. `prefixes` works the same way.

### Merge order

```
what Pi already had
  → catalog metadata (filtered by the policies above)
  → the matched prefix rule's override
  → the matched suffix rule's override
  → the model's own override
```

Two things always win over all of it: fields you hand-wrote in `models.json` `models[]` are never
overwritten by a catalog, and Pi applies `models.json` `modelOverrides` above this extension
entirely.

## `/model-info`

```
/model-info                     what was completed, what stayed ambiguous, catalog freshness
/model-info <provider>/<model>  where each field came from
/model-info refresh             re-check the catalogs now
```

```
requested:  my-relay/gpt-5.6-sol-free
canonical:  openai/gpt-5.6-sol  (pi.dev)
match:      stripped
rule:       free-dash

context:    1050000   from pi.dev
maxTokens:  128000    from pi.dev
reasoning:  true      from pi.dev
cost:       $0/$0 per Mtok   from rule 'free-dash'
```

## Limits

- A provider whose registration slot is already taken, or whose `models[]` models.json spells out,
  can only be completed by replacement, which fixes its list for the session. It warns when it sees
  one; a mid-session change is picked up on the next agent turn. See
  [Staying current](#staying-current).
- If two extensions complete the same provider, the last one to register wins.
- With no cache and no network, nothing is applied at all rather than partially.

## License

[MIT](./LICENSE)
