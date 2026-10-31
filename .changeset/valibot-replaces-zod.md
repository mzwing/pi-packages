---
"@mzwing/pi-codex-downgrade-detector": patch
"@mzwing/pi-model-info": patch
"@mzwing/pi-permission-auto-review": patch
"@mzwing/pi-task-governor": patch
---

fix: validate configs with valibot instead of zod

pi-codex-downgrade-detector, pi-model-info, pi-permission-auto-review and pi-task-governor no longer depend on zod: they validate their config with valibot, bundled into each package, so installing one adds nothing beyond its peer dependencies. Config errors follow valibot's wording, and an unknown key is reported at its own path, as in `reasonning: Invalid key: Expected never but received "reasonning"`.

pi-model-info reports a rule id or a source given twice against the file that repeats it. Before, it named the project's config file wherever the repeat was.
