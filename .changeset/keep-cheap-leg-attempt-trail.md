---
'@polyrouter/frontend': minor
'@polyrouter/shared': minor
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
---

An escalated request keeps its cheap leg's attempts, including a call the cheap deadline cut off

When a cascade request's cheap leg failed and the strong tier then served it cleanly, the request is recorded `success`, and until now its cheap leg's failed or skipped attempts were thrown away, so the Route Trace could only say `cheap leg · attempts not recorded`. Those attempts are now kept, and the trace draws them under the `cheap leg` row with no ERROR card. A cheap call the cheap-response deadline (`ROUTING_CASCADE_CHEAP_TIMEOUT_MS`) cut off is now recorded too, whether or not its response headers had arrived, and reads `<model> · no reply by the cheap deadline` instead of nothing or `unavailable`. The request's `status` is unchanged, so the Fallbacks filter and every status count stay as they were; a cancelled request still keeps no attempt trail. API: in the request listing, `attemptFailures` can now be non-null on an escalated `success` row, and an entry can carry `stopReason: 'deadline'`. One narrow routing-reason change: if the cut cheap call was sent with an output-cap clamp, that clamp now appears in the reason's `cheap[…]` note. Rows recorded before this release are not backfilled and read as before. No migration.
