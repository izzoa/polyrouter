# analytics-api — delta for fix-analytics-keyset-cursor

## MODIFIED Requirements

### Requirement: The request listing is keyset-paginated with the decision inspector fields

The request listing SHALL return owner-scoped request-log rows newest-first with the transparency fields (`decision_layer` + `routing_reason`, §9) plus tokens, snapshot prices, the served cost, this request's attempt cost, latency, status, escalation, and owner-scoped model/provider/agent labels (id fallback when a catalog row was deleted), as a **safe view** that never includes ownership columns. It SHALL paginate by a stable keyset cursor (over `created_at`,`id`, tie-broken by the PK so batch-inserted equal timestamps don't skip or duplicate rows) so walking all pages returns every in-range row exactly once, and SHALL support filtering by `status`, `decision_layer`, and `escalated`. The cursor SHALL preserve the **full stored precision** of `created_at` (which is `now()`-microsecond precision, shared identically across every row of a single batched insert) rather than a truncated round-trip: encoding and the next-page comparison SHALL both operate at the column's precision, so a page boundary landing inside a group of rows sharing one microsecond-precision `created_at` never skips or duplicates the remainder of that group.

#### Scenario: Paging walks every row once

- WHEN a client pages through the request listing for a range using the returned `nextCursor`
- THEN each in-range row appears exactly once across pages in newest-first order, and the final page returns a null cursor

#### Scenario: A microsecond-precision batch pages exactly once

- WHEN several rows are inserted in one batched `INSERT` (so they share one identical microsecond-precision `created_at` from `now()`) and the client walks the listing one row per page
- THEN every row in that tie group appears exactly once across pages (none is silently skipped by a millisecond-truncated cursor), tie-broken by the PK

#### Scenario: The listing omits ownership columns

- WHEN the request listing is returned
- THEN each row exposes the metadata/decision/cost fields but not `owner_user_id`/`org_id`
