# request-logging Specification

## Purpose
TBD - created by archiving change add-request-logging. Update Purpose after archive.
## Requirements
### Requirement: Every routed request writes a metadata-only RequestLog

The system SHALL record a RequestLog row for every request the proxy (#10) handles — success or error (best-effort durable, per the async-writer requirement) — capturing `agent_id`, `provider_id`, `model_id`, `tier_assigned`, `decision_layer`, `routing_reason`, token counts, price snapshots, `cost`, `duration_ms`, and `status` (spec §5, §7.5). Token counts store the IR's **uncached** `input_tokens` and `output_tokens` with `cache_read_tokens`/`cache_write_tokens` separate (total input = input + cache-read + cache-write). It SHALL store **metadata only**: no prompt or response body is persisted unless the user explicitly opts in (invariant 8), and no secret is written.

#### Scenario: A completed request produces a record with the routing decision

- WHEN the proxy completes a request (streaming or non-streaming)
- THEN a RequestLog row is recorded for it, carrying the resolved `decision_layer` (`explicit`|`header`|`default`), a human-readable `routing_reason`, the `tier_assigned` (the resolved tier key, or null for an explicitly-named model), the model/provider/agent, `duration_ms`, and `status = success`
- AND the row contains no prompt or response text

#### Scenario: A failed request is also recorded

- WHEN the upstream call errors
- THEN a RequestLog row is written with `status = error` (tokens estimated or zero, no body), so failures are visible in analytics

### Requirement: Cost is computed at request time against snapshotted unit prices and is immutable

The system SHALL compute `cost` when the request completes using the unit prices **then in effect** (via #8's effective-dated catalog) and **snapshot those unit prices onto the row** (`input_price_snapshot`/`output_price_snapshot`, plus cache-rate snapshots and the `price_version_id`) (spec §7.7, invariant 4). Historical cost SHALL never be recomputed against current prices. When the price is unknown, `cost` and the snapshots are null (a well-defined "unknown", distinct from `usage_estimated`). Prices come from the bundled catalog, never a provider `/models` call, and are USD-only.

#### Scenario: A later price change does not move a recorded cost

- WHEN a RequestLog is written with its unit-price snapshots and cost
- AND the model's catalog price is later changed (a new effective-dated version is appended)
- THEN the existing row's `cost`, `input_price_snapshot`, and `output_price_snapshot` are unchanged, and historical spend does not move

#### Scenario: An unknown price yields a null cost, not a wrong one

- WHEN no catalog price resolves for the model at request time
- THEN `cost` and the price snapshots are null (not zero or a stale value), while tokens are still recorded

#### Scenario: Cache usage without a cache rate is null cost, never understated

- WHEN a request has non-zero cache-read/write tokens but the resolved price has no cache rate for that component (and the model is not free)
- THEN `cost` is null (the true cost is unknown) rather than an understated cost that omits the cache component — immutable cost is never recorded too low

### Requirement: Missing or partial provider usage is estimated and flagged, never null

The system SHALL prefer the provider's `usage`; when it is missing or partial (some providers omit it, send it only in the final streamed chunk, or drop it on error) it SHALL estimate tokens (output from the streamed/returned text, input from the request — a rough `chars/4`, **no billing tokenizer on the hot path**) and set `usage_estimated = true`, so a row never stores silent-null usage (spec §7.7, invariants 4, 9).

#### Scenario: A provider that omits usage is flagged estimated

- WHEN the provider returns no (or partial) `usage`
- THEN the row's token counts are filled from an estimate and `usage_estimated = true`
- WHEN the provider returns complete `usage`
- THEN those exact counts are used and `usage_estimated = false`

#### Scenario: A tool-only response without usage still estimates output

- WHEN a response (buffered or streamed) has no assistant text — only tool calls — and the provider omits usage
- THEN the output estimate counts the tool name + argument characters (not just text), so `output_tokens` is non-zero and `usage_estimated = true`

### Requirement: Logging is asynchronous, batched, failure-isolated, and best-effort durable

Writing a RequestLog SHALL NOT sit synchronously on the request path (spec §3.2.4, invariant 9): the request-completion handler enqueues a metadata draft (no DB call), and a batched background writer resolves the price snapshot (bounded concurrency), computes cost, and inserts rows (interval/size threshold, plus a flush on shutdown after stream drain) with a bounded queue. A logging failure SHALL never fail or delay the client request. Durability is **best-effort**: a failed batch is retried a bounded number of times with backoff so a transient database failure does not create gaps; only a sustained outage past the retry budget (or a hard crash / queue overflow) drops rows, and such drops are logged/metered — never silent. The **shutdown flush SHALL drain to completion within a bounded time**: it SHALL keep flushing until both the log and attempt queues are empty (or their rows are counted as dropped), even if it begins while a periodic flush is already in flight — a concurrent flush SHALL coalesce rather than early-return, so drafts enqueued after an in-flight flush's splice (e.g. the final rows from a just-drained stream) are still written or counted, never silently lost. Each batch's DB work SHALL be bounded by a per-operation timeout so a hung database cannot leave the drain (and thus process shutdown) blocked indefinitely; a timed-out batch is retried under the same idempotent row ids and, past the retry budget, its rows are counted-as-dropped, so the drain always terminates. (An absolute one-row-per-request guarantee is the optional Redis-buffer upgrade, spec §3.2.)

#### Scenario: A log-write failure does not fail the request; transient failures retry

- WHEN the batched insert fails (e.g. the database is briefly unavailable)
- THEN the client request that produced the row still succeeds, and the writer retries the batch (bounded, with backoff) rather than dropping it immediately, continuing to serve later rows
- WHEN the failure is sustained past the retry budget (or the queue overflows)
- THEN rows are dropped with a logged/metered count, never silently

#### Scenario: A retry after an ambiguous failure does not duplicate a row

- WHEN a batched insert commits but the acknowledgement is lost, and the writer retries the batch
- THEN each row carries the id it was allocated when enqueued and is inserted with conflict-ignore semantics, so exactly one row exists — spend is never double-counted

#### Scenario: Recording does not block the response or the routing pool

- WHEN a request completes
- THEN its metadata draft is enqueued and the response returns without awaiting the database write or the price lookup (the price lookup runs later in the bounded-concurrency writer, using the request-completion timestamp so cost stays immutable)

#### Scenario: The shutdown flush drains drafts enqueued during an in-flight flush

- WHEN a periodic flush is mid-retry (its splice already taken) and shutdown begins, and further drafts are enqueued after that splice
- THEN the shutdown flush does not early-return on the in-flight flush; it drains until both queues are empty, so the late drafts are written (or counted as dropped) before the process exits — none are silently lost

### Requirement: Logs are tenant-scoped and survive referenced-row deletion

Reads of RequestLog SHALL be ownership-scoped to the authenticated principal (invariant 5); no row is returned by id without an ownership guard. The `agent_id`/`provider_id`/`model_id` are **denormalized ids (not foreign keys)**, so deleting a referenced provider, model, or agent SHALL NOT delete, mutate, or (for a still-queued row) fail to insert a historical log — preserving immutable cost and history.

#### Scenario: Another tenant's logs are invisible

- WHEN principal B lists or fetches RequestLogs
- THEN only B's rows are returned; A's rows are never returned by id or in a list

#### Scenario: Deleting a model preserves its historical logs

- WHEN a model (or its provider/agent) is deleted — before or after its logs are flushed
- THEN prior RequestLog rows are written/remain, with the snapshotted prices and cost and the recorded `model_id` intact (the id is a denormalized value, not a cascading FK) — history and past spend are unchanged

