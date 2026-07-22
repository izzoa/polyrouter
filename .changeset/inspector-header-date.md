---
'@polyrouter/frontend': patch
---

The request inspector header now shows the date alongside the time (e.g. `2026-07-22
10:01:58`) instead of time alone, so a request's timestamp is unambiguous across days.
New `fmtDate`/`fmtDateTime` helpers render an ISO `YYYY-MM-DD` date to match the header's
technical mono treatment; scoped to the inspector (the request table stays compact
time-only). No behavior change beyond the display.
