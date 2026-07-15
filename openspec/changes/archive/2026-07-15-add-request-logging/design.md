# Design: add-request-logging

## Context

#10 resolves a route (`RouteDecision`: provider/model/decisionLayer/routingReason) and calls the provider through `ProxyCore`. #8 gives `PricingService.resolveForModel(model, baseUrl, kind, at) → PriceSnapshot | null`. #11 records the outcome of each #10 request immutably and off the hot path. It mirrors #10's split: framework-agnostic pieces (cost math, usage estimation, stream capture) in data-plane; the DB writer + pricing integration in control-plane.

## Decision 1 — Schema: denormalized ids (no cross-ref FKs), owner-scoped, USD-only

`owner_user_id`/`org_id` use the owned pattern (owner FK, cascade on user delete) and scope reads. **`agent_id`/`provider_id`/`model_id` are plain nullable id columns — NOT foreign keys.** A RequestLog is an append-only audit record; an FK would (a) let a concurrent provider/model/agent deletion between enqueue and the batched insert fail — and roll back — the whole batch, and (b) require `ON DELETE SET NULL` just to preserve history. Denormalized ids sidestep both: the historical id is retained even after its row is deleted (better for audit), and inserts never race a deletion. Only `owner_user_id` keeps its FK (a tenant deleting itself mid-request is negligible and cascade-cleanup of its logs is desired).

Columns: `tier_assigned` (nullable), `decision_layer`, `routing_reason`; **`input_tokens`** (int notNull — **uncached** input, matching the IR) and `output_tokens` (int notNull); `cache_read_tokens`/`cache_write_tokens` (nullable — so `total input = input_tokens + cache_read + cache_write`); `input_price_snapshot`/`output_price_snapshot`/`cache_read_price_snapshot`/`cache_write_price_snapshot` (double nullable), `price_version_id` (nullable); `usage_estimated` (bool); `cost` (double **nullable** = price unknown); `duration_ms` (int); `status` (`success`|`error`; `fallback`/`escalated` reserved for #12/#13); `escalated` (bool default false), `quality_signal` (double nullable); `created_at`. Indexes: `created_at`, `owner_user_id`, `agent_id`, `provider_id`, `model_id`. CHECK token counts `>= 0`. No currency column — USD-only per #8.

## Decision 2 — Pure cost + estimation in data-plane (cache-safe, tool-aware)

`data-plane/src/recording/cost.ts` (pure — no DB/clock/network):
- `computeCost(usage, price: PriceSnapshot | null) → number | null` — `Σ (component_tokens / 1e6) × rate` over uncached-input/output/cache-read/cache-write. Returns **null** when `price` is null (unknown). Crucially, **if a non-zero cache component has a null rate, returns null** (not an understated cost) — unless `price.isFree` (→ 0). Input/output rates are always present on a non-null `PriceSnapshot`; only cache rates are nullable (and model-own prices always null them), so a cache-using request against a catalog without cache rates records an honest `cost=null`, never a too-low one (invariant 4).
- `estimateTokens(text, toolChars)` — `Math.ceil((textChars + toolChars) / 4)`, the routing-grade estimate (invariant 9); no tokenizer. Output estimation counts assistant **text plus tool-call name + argument characters** (a tool-only response must not estimate 0 output); values are counted, never retained.
- `resolveUsage({ providerUsage, requestChars, outputText, outputToolChars }) → { inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, estimated }` — prefer complete provider usage; else estimate the missing components and set `estimated=true`. Because `inputTokens` is **uncached**, an estimated input in the presence of *known* cache tokens is `max(0, estimatedTotalInput − knownCacheRead − knownCacheWrite)` — the `chars/4` estimate is of total input, so the known cache portion is subtracted rather than double-counted. Output estimate = `estimateTokens(outputText, outputToolChars)`.
- A `RequestLogDraft` type — the metadata shape (no bodies, invariant 8).

## Decision 3 — Usage capture without buffering the body (ProxyCore, additive)

Recording streamed usage needs IR events, which only `ProxyCore` sees. Extend it additively (no #10 behavior change):
- `runBuffered` returns `{ wire, response }` so the caller reads `response.usage` + counts `response.content` (text + tool name/args) for an estimate.
- `openStream` also returns `outcome: Promise<StreamOutcome>` (`{ status: 'success'|'error'; usage: PartialUsage; outputChars: number }`). Usage accumulates via #5's **`mergePartialUsage`** (component-wise, later value wins — never summed, so a repeated component can't double-count) from `message_start`/`message_delta`, and sums `text_delta` + `tool_use_start` name + `tool_use_delta` JSON lengths. The outcome is settled through a **resolve-once guard held outside the generator**: the inner frame generator settles it (success on a clean end, error on a mid-stream failure), and the returned `frames` is an **iterator wrapper whose `return()`/`throw()` also settle it (error-with-partial-usage)** — crucially even when the consumer `return()`s *before the first `next()`* (a client disconnect in the window between `stream()` returning and the pump's first iteration), since an async generator's own `finally` does NOT run in that case. So `outcome` resolves exactly once on every path: completion, mid-stream error, and pre- or mid-iteration disconnect. The client stream is never buffered; capture is a side-effect of pass-through.

## Decision 4 — Draft-then-price: a bounded, failure-isolated async writer

To keep pricing's DB read off the request path (and from growing unboundedly during a DB stall), `record()` (the recorder) does **no DB work**: it **allocates the row `id`** (a stable UUID, fixed for the row's life), runs the pure `resolveUsage` (estimation is cheap), and builds a metadata `RequestLogDraft` — carrying the `id`, the owning `principal`, the resolved usage, the pricing *inputs* (model `externalModelId` + own prices + `isFree`, provider `baseUrl` + `kind`) and the effective `at` (request-completion time) — then enqueues it. The **`LogWriter`** owns all DB work, grouped **per principal**:
- for each draft, resolves the price snapshot via #8's `resolveForModel(inputs, at)` under **bounded concurrency**, then `computeCost` — resolving with the captured `at` yields the price *then in effect* even though it runs slightly later, so immutability holds;
- batch-inserts a principal's finished rows via `insertMany(principal, rowsWithoutOwner)`, **`ON CONFLICT (id) DO NOTHING`** — so a commit-then-lost-ack retry can never duplicate a row (no double-counted spend), and owner is derived from the principal (never client input).
- **Failure isolation + bounded retry** wraps the whole **resolve-price + insert** attempt (a pricing lookup can fail during a DB outage too): a failed principal-batch is **retried a bounded number of times with backoff** before its rows are dropped-and-counted (a transient DB blip creates no gaps; a sustained outage past the budget drops with a logged/metered count — no silent loss). Batching per principal means a deleted owner's FK failure can't poison another tenant's rows. The queue is size-bounded; overflow drops oldest with a logged count. Nothing here throws into or blocks the request path.
- `OnModuleInit` starts an interval flush; a size threshold triggers an early flush; the **final flush runs in `onApplicationShutdown`** — *after* #10's stream drain (`beforeApplicationShutdown`), so streams settle their outcomes and enqueue before the last flush.

(A Redis/BullMQ buffer is the documented multi-instance-durability upgrade; the in-memory writer is correct across instances — each appends to the shared table.)

## Decision 5 — Persistence accessor

Add `requestLogs` to `PersistencePort`: **`insertMany(principal, rows: RequestLogInsertInput[]): Promise<void>`** — one principal's batch, owner forced from `principal` at the boundary (the "owner not caller-controlled" guarantee is enforced by the *signature*), each row inserted with its pre-allocated `id` under **`ON CONFLICT (id) DO NOTHING`** (idempotent retry). Plus tenant-scoped `list(principal)` / `findById(principal, id)` (owned reads for the cost-immutability e2e and §9 analytics later; no unscoped by-id read). `RequestLogInsertInput` carries the pre-allocated `id` but **not** the owner.

## Decision 6 — Hook in ProxyService

Extend `RouteDecision` (data-plane resolver) with **`tierKey: string | null`** — set for every tier path (explicit-tier, header, custom/default rule targeting a tier, default tier), null for a direct model target — so `tier_assigned` has a producer. `prepare` returns a `RecordingContext` (owner principal, `agentId`, the `RouteDecision`, provider + model rows, `startedAt`). `completion` records after `chat` in both success and error branches; `stream` records via `outcome.then(...)` after commit and immediately on a pre-commit error. All recording is fire-and-forget. The controller threads the guard's `req.agentId` into `ProxyService`.

## Risks / trade-offs

- **Best-effort durability** — bounded retry survives transient DB failures; a hard crash or an outage past the retry budget can still drop un-flushed rows (logged/metered, never silent). The spec requirement is stated as best-effort; strict once-per-request durability is the Redis-buffer upgrade (§3.2).
- **`chars/4` (text + tool) estimates are rough** — intended (invariant 9); `usage_estimated=true` marks them.
- **Denormalized ids can dangle** after a provider/model/agent deletion — intended for an immutable audit log; reads join nothing, and §9 analytics will tolerate null/dangling ids.
