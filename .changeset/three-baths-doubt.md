---
"@mzwing/pi-model-info": patch
---

perf(pi-model-info): register a provider again only when its catalog or model list changed

A session that started on an unexpired cached catalog registered each completed provider twice, once from the cache and once more from the refresh that found it current, and every registration makes Pi rebuild and refresh its whole model list. It now registers once, and when another extension changes a provider's model list, only that provider registers again.
