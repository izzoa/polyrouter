---
'@polyrouter/frontend': minor
---

The Route Trace names a cascade request's legs and why it escalated

A cascade request's trace in the request inspector now groups its walk under leg rows on the spine: a `cheap leg` row and, when the request escalated, an `escalation` row that states the recorded cause (`quality gate`, or `cheap leg did not serve` for a cheap chain that failed, timed out, was skipped or could not be replayed). An escalation whose cheap leg left no record reads `cheap leg · attempts not recorded` instead of drawing nothing, and a cheap answer the cascade kept states `quality gate passed · q=<score>` under the served node. Attempt nodes no longer repeat a leg tag. The Decision section no longer prints a `quality signal` on an escalation the cheap leg caused (`cheap leg did not serve`): there the recorded figure is a placeholder zero, or the passing score of an answer whose replay then failed, and not the gate's verdict on the escalation. Rows recorded before the escalation source existed still show what they recorded, and the verbatim routing reason is unchanged. Display only: nothing new is recorded or returned by the API.
