---
"@mzwing/pi-permission-auto-review": patch
---

fix(pi-permission-auto-review): run the `claude-code` fast pass at the least effort the model allows

The fast pass asked for no reasoning, which a model that cannot turn thinking off, such as Claude Sonnet 5.5, answered at its default effort under the fast pass's 1024-token cap. Review calls now fit `reasoning` to the levels the model offers, as Pi does for its own turns, so the fast pass runs at the model's least effort, `low` on Claude Sonnet 5.5, and so does a configured `off`.
