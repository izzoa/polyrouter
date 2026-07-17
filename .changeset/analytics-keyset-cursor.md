---
'@polyrouter/control-plane': patch
'@polyrouter/shared': patch
---

Fix analytics pagination silently dropping rows (FABLE_AUDIT epic E3).

The request-listing keyset cursor round-tripped `created_at` through a millisecond-precision JS `Date`, but the column stores microsecond-precision `now()` and the LogWriter flushes each batch in one `INSERT` (so every row in a batch shares one identical µs timestamp). A page boundary landing inside such a tie group compared a truncated `.123` against a stored `.123456` and matched neither the `<` nor the `=` branch, silently skipping the rest of the group — the rows were still counted in the summary, so the dashboard was inconsistent with itself.

The cursor now carries the full-precision `created_at::text` value and the next-page predicate binds it back as `::timestamptz`, so a microsecond-precision batch pages exactly once. Code-only — no migration, and historical rows are fixed too.
