## MODIFIED Requirements

### Requirement: Logging is asynchronous, batched, failure-isolated, and best-effort durable

Writing a RequestLog SHALL NOT sit synchronously on the request path (spec §3.2.4, invariant 9): the request-completion handler enqueues a metadata draft (no DB call), and a batched background writer resolves the price snapshot (bounded concurrency), computes cost, and inserts rows (interval/size threshold, plus a flush on shutdown after stream drain) with a bounded queue. A logging failure SHALL never fail or delay the client request. Durability is **best-effort**: a failed batch is retried a bounded number of times with backoff so a transient database failure does not create gaps; only a sustained outage past the retry budget (or a hard crash / queue overflow) drops rows, and such drops are logged/metered — never silent. The **shutdown flush SHALL drain to completion within a bounded time**: it SHALL keep flushing until both the log and attempt queues are empty (or their rows are counted as dropped), even if it begins while a periodic flush is already in flight — a concurrent flush SHALL coalesce rather than early-return, so drafts enqueued after an in-flight flush's splice (e.g. the final rows from a just-drained stream) are still written or counted, never silently lost. Each batch's DB work SHALL be bounded by a per-operation timeout so a hung database cannot leave the drain (and thus process shutdown) blocked indefinitely; a timed-out batch is retried under the same idempotent row ids and, past the retry budget, its rows are counted-as-dropped, so the drain always terminates. (An absolute one-row-per-request guarantee is the optional Redis-buffer upgrade, spec §3.2.)

A cascade `request_attempt` ledger row carries a foreign key to its served `request_log`. Within a flush cycle the writer SHALL insert attempts **only for parents it actually wrote this cycle**: an attempt whose parent `request_log` was not written (its group's insert gave up, or the parent draft was queue-evicted) is **orphaned** and cannot be inserted regardless — the writer SHALL drop it as a counted/logged row *before* grouping the attempt inserts, so a single orphan does not FK-poison and fail its whole per-owner attempt batch (which would drop valid sibling attempts whose parents were written). Because a served log and its attempts are enqueued in the same tick, a non-orphan attempt's parent is always present in the same cycle.

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

#### Scenario: An orphaned attempt is dropped without poisoning its batch

- WHEN a flush cycle contains an attempt whose parent `request_log` was not written this cycle (its group's insert gave up, or the parent was queue-evicted), alongside other attempts whose parents were written
- THEN the orphaned attempt is dropped as a counted/logged row and the attempts with written parents are still inserted — the whole per-owner attempt batch is not failed by the one orphan's foreign-key violation
