---
'@polyrouter/shared': minor
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
---

Per-attempt fallback forensics, and a breaker probe that can actually recover a
slow provider.

A failed request's trail no longer collapses four different causes into one
word. A chain member skipped because its provider's circuit breaker was open —
never contacted at all — now records `skip@model` in the routing reason instead
of impersonating an upstream `unavailable` failure, and `status=error` rows
additionally persist structured per-attempt failure metadata (new
`request_log.attempt_failures` jsonb, migration 0025): per walked member its
mapped error kind, upstream HTTP status when one existed, a dispatched-vs-
skipped flag, the cascade leg, and a recorder-set terminal marker — aggregated
across BOTH cascade legs (previously the superseded cheap leg's failures were
dropped entirely at escalation). Structure only: the shape has no free-text
field, so the no-verbatim rule for superseded members stands. The metadata rides
the request listing's safe view, and the inspector renders a structural
"Fallback trail" — skips labeled "skipped — circuit open (provider not
contacted)" — plus an honest ERROR-card note when the terminal member was a
never-dispatched skip.

The half-open breaker probe now runs with widened patience: its first-byte and
idle bounds double (capped at the 1 h ceiling), the derived event/dispatcher
bounds follow, and the probe's lease is granted, renewed, and TTL-protected at
the widened duration — on the buffered path too, whose body bytes now feed lease
renewal. A provider tripped by workload-shaped timeouts (heavy prompts on slow
models) can therefore pass its recovery probe on the same workload and close the
breaker, instead of being re-tripped indefinitely; a genuinely hung provider
still times out typed at the widened bound and re-opens.
