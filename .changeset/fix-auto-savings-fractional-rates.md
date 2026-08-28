---
"@polyrouter/control-plane": patch
---

**Auto performance no longer 500s once the counterfactual basis has a real price.** `GET /api/analytics/auto` bound the `auto_high` basis's per-1M rates straight into `integer_column * $n`, and Postgres types an untyped parameter from the operator it meets — so it resolved each rate to `integer` and rejected the first fractional one (`22P02 invalid input syntax for type integer: "1.4"`), failing the whole request rather than the savings block. Any basis model whose input or output price is not a whole number of dollars per 1M tokens — i.e. essentially every catalog model — took the Auto-performance card down with it. The rates are now pinned to `double precision`, the same float arithmetic `computeCost` used to write the actual costs the counterfactual is subtracted from; integer-rate results are bit-identical to before. The savings e2e now prices its basis fractionally (1.4 / 4.4), which is what let this reach a release.

Background jobs also report **why** they failed: a BullMQ `failed` handler logged only `err.message`, which for a wrapped `DrizzleQueryError` is the SQL — the actual reason (`ENOTFOUND`, a dropped connection, a SQLSTATE) sat unread in `cause`. All seven schedulers (budget eval, notify delivery, weekly summary, calibration, body purge, semantic learning, pricing refresh) now log the cause chain, clipped to one line.
