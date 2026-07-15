# Design: add-cascade-routing

## Context

#10 built the commit-gated proxy + `openAttemptStream` (create the AbortController, gate the first event, wrap frames so a serialization failure emits the terminal frame and a consumer disconnect settles the outcome `error`). #12 added the chain walkers (`runBufferedChain` → `{ok, wire, response, servedIndex, failures}`; `openStreamChain` → committed `{frames, outcome, servedIndex, failures}` or pre-commit `{kind:'error'}`) and the mid-stream commit boundary. #13 added structural classification (`auto` → `high`/`low` band → tier, else `ambiguous`), the `auto_high`/`auto_low` band-target RoutingRules, and the exported `resolveTarget` + rule comparator. `client.streamSerialize(events, {created})` turns `NormalizedStreamEvent`s into client SSE. #11's `request_log` already carries `escalated boolean` + `quality_signal double precision` (defaulted). Cascade slots in at Layer 1's `ambiguous` output.

Governing constraints: **invariant 3** (never swap a committed stream), **invariant 1** (never fail/stall — always degrade to the reliable core), **invariant 4** (record every billable call at its immutable snapshot price), **invariant 9** (no tokenizer / no per-request LLM on the hot path).

## Decision 1 — Trigger on Layer 1 `ambiguous`; cascade implies structural

`StructuralRouter` exposes a discriminated evaluation:

```
type StructuralEvaluation =
  | { kind: 'route'; decision: RouteDecision }   // confident band → routed (#13)
  | { kind: 'ambiguous' }                          // classified, between thresholds
  | { kind: 'skip' }                               // disabled / error / no band rule
```

`evaluate()` runs extract → baseline read → classify → fire-and-forget observe → confident band via the shared `resolveBandTarget`; `decide()` (the #13 API) becomes a thin adapter (`route → decision`, else `null`) so #13 is unchanged. `ProxyService` calls `evaluate()`; `ambiguous` + cascade-eligible → cascade, else the Layer-0 `default` stands.

Cascade needs the ambiguity signal, so **enabling `cascade` implies `structural`**: the config loader adds `structural` to the effective auto-layer set whenever `cascade` is present (no silent no-op config trap).

## Decision 2 — The cheap tier is BUFFERED with a bounded deadline; timeout ≠ disconnect

The cheap attempt is always `runBufferedChain` (non-streaming upstream) — a full response for the gate, and nothing is forwarded, so there is no committed stream to swap (invariant 3 holds by construction). Because #6's HTTP timeout ends when response *headers* arrive (a 200 can then hang draining the body), the cheap attempt runs under a **bounded full-response deadline**: `signal = AbortSignal.any([clientSignal, AbortSignal.timeout(ROUTING_CASCADE_CHEAP_TIMEOUT_MS)])` (default `30_000`). After the cheap attempt resolves/fails, the two abort causes are distinguished by checking `clientSignal.aborted`:

- **client disconnected** → stop immediately; do NOT call the strong tier and do NOT record a strong row.
- **deadline or a real error** → escalate.

`CascadeRouter.plan(snapshot)` resolves the cheap chain from `auto_low` and the strong chain from `auto_high` (both via `resolveBandTarget`, `decisionLayer='cascade'`); `null` if either is missing → the Layer-0 default stands. `ProxyService` builds a lazy `ChainAttempt[]` + `meta[]` bundle for each chain via a factored helper (reused for the primary/default, cheap, and strong chains).

## Decision 3 — Pure, language-neutral, tokenizer-free quality score

`evaluateQuality(response): number` returns a **binary** score from structural signals only (invariant 9 — language-neutral); the baseline detections are hard capability failures, so `0` (unusable → escalate) or `1.0` (usable). The `double precision` column keeps a graded future (verifier/self-consistency scores) open. Score `0` when **any** of:

- **empty** — no non-whitespace text AND no tool calls.
- **error stop** — `stopReason === 'error'`.
- **content-filtered** — `stopReason === 'content_filter'` (a structural refusal/block).
- **malformed output** — any `tool_use` with `inputParseError` (invalid JSON args).

otherwise `1.0`. Deliberately **not** penalized: `tool_use`/`pause` stops (a legitimate agentic tool call is a correct response, not a bad answer) and `length` (a valid long answer truncated at the same `max_tokens` a stronger model shares — escalating would not help). A binary score means **any** positive threshold escalates an unusable answer, closing the "malformed at 0.2 doesn't escalate under a 0.2 threshold" gap. `CascadeRouter.shouldEscalate(response) → { score, escalate }` escalates when `score < ROUTING_CASCADE_QUALITY_THRESHOLD` (domain `(0,1]`, default `0.5`). If `evaluateQuality` throws, cascade **fails open** (deliver the cheap answer) but records `quality_signal = null` (never a false `1.0`). Verifier/self-consistency/LLM-judge and linguistic refusal checks are declared cloud/opt-in follow-ups.

## Decision 4 — Deliver exactly one tier; reuse the commit machinery; rescue to default

The escalation chain is **`strong ++ default`** — the `auto_high` members followed by the Layer-0 default bundle prepare already built for this ambiguous request. So a single `runBufferedChain`/`openStreamChain` over the escalation chain walks strong → default with #12's breaker + fallback, guaranteeing the reliable core still serves if the strong tier is down (invariant 1). Each `AttemptMeta` carries its **`tierKey`** (cheap/strong/default), so when a default member serves after strong exhausts, recording uses `meta[servedIndex].tierKey` — the served row is `tier_assigned=default` with the default model's price (not the strong tier's). `openStreamChain` visits a next member only *before* its first successful event, so the walk is commit-safe. After the cheap buffered attempt:

- **cheap chain failed (no billable response)** → escalate (run the escalation chain).
- **pass** (`score ≥ threshold`) → deliver the cheap answer. Non-streaming → return `cheap.wire`. Streaming → **replay** via a dedicated `replayBufferedStream(client, cheap.response, opts)` that **pre-materializes** the SSE frames from the already-buffered response (`responseToStreamEvents` → `client.streamSerialize`, drained to an array). Because the source is fully buffered, materialization is bounded and — crucially — a synthesis/serialization failure happens **before any byte reaches the client**, so it safely **escalates** instead of erroring a valid cheap answer. On success it returns a frame generator (backpressure per frame) wrapped to settle a delivery `outcome` (a client disconnect mid-replay → `error`).
- **escalate** → run the escalation chain. Non-streaming → `runBufferedChain`. Streaming → `openStreamChain` live (commit-on-first-token; a post-commit failure is #10's terminal frame — no rescue past commit; a pre-commit strong failure falls through to default within the same walk).

Only one of {pre-materialized cheap replay, live escalation stream} ever reaches the client → **no mid-stream swap** is possible.

## Decision 5 — Recording: `request_log` served summary + a `request_attempt` cost ledger

Cascade can make more than one billable upstream call, so every one must be captured at request time at its immutable snapshot price (invariant 4 — the data is unrecoverable later). The model keeps the existing `request_log` (one row per request = the served summary, so #11's `request_log.cost` contract + its immutability e2e are untouched) and adds a child ledger for the *extra* calls:

- **`request_log`** — the served member (as #10–#13): `decision_layer='cascade'`, `escalated`, `quality_signal` (binary score, or `null` on fail-open error), `tier_assigned` = the served tier (correctly `default` on rescue, via a per-attempt `tierKey` on `AttemptMeta`), served model/price/usage/cost.
- **`request_attempt`** (NEW table) — the **additional** billable calls beyond the served one: the superseded cheap attempt on an escalation. Columns mirror `request_log`'s cost/token/price snapshot set (immutable) + `request_log_id` FK (cascade delete), `owner_user_id` (tenant-scoped), `attempt_index`, `tier_key`, `provider_id`, `model_id`, `status`. Non-cascade and cascade-**pass** requests write **no** attempt rows.

**Total spend = `request_log.cost` + Σ `request_attempt.cost`** — one uniform formula for #16/#17 (it reduces to `request_log.cost` when the ledger is empty). Recording:

- **pass** → `request_log` only (cheap served, `escalated=false`).
- **escalate, cheap succeeded** → `request_log` for the served escalation member (`escalated=true`) **+** one `request_attempt` for the superseded cheap call (its own usage/price/cost). `RequestRecorder.record(...)` returns the request id; `recordAttempt(requestLogId, cheapCtx, cheapOutcome)` links the cheap ledger row.
- **escalate, cheap failed / timed out** → no cheap ledger row (no billable usage); `quality_signal=0` on the served row (a cheap failure is the worst quality).
- **whole cascade fails** → one `status=error` `request_log` row (as #12).

`RecordOutcome` gains `escalated?: boolean` + `qualitySignal?: number | null` (default `false`/`null` — #10–#13 unchanged); `RequestLogDraft`/`toRow` insert them. A `RequestAttemptDraft` + the writer's `request_attempt` batch insert reuse the same bounded price-resolution as `request_log`. `status` stays `success|error|fallback` with `escalated` orthogonal.

**Billable-usage source.** For the streamed passing-cheap replay, the `request_log` row's `providerUsage`/output chars come from the fully-buffered **`cheap.response`** (the complete, billed call) — NOT the replay's client-delivery accumulator (which an early disconnect would truncate); only the delivery **status** comes from the replay outcome. Live escalation streams record from their outcome as #12. Non-streaming records after the buffered result.

## Decision 6 — `responseToStreamEvents` fidelity

`responseToStreamEvents(response): NormalizedStreamEvent[]` (pure) synthesizes an array that `replayBufferedStream` wraps in an async generator before `client.streamSerialize` (which takes an `AsyncIterable`): `message_start` {id, model, role, usage = input/cache components} → **per content block**: text → `text_delta` **then `block_stop`**; `tool_use` → `tool_use_start` + a single `tool_use_delta` (`JSON.stringify(input)` for parsed, exact `inputRaw` for a parse error) + `block_stop{finalizedToolUse}` → `message_delta` {stopReason, rawStopReason?, stopSequence?, usage = output component} → `message_stop`. **`block_stop` is emitted for every block (text and tool)** so the Anthropic serializer closes each `content_block` (it emits `content_block_stop` only on a `block_stop`); usage placement mirrors a real upstream so `accumulate` reconstructs the same totals; stop fidelity is preserved. Tested for both OpenAI and Anthropic clients across text, tool-only, parallel-tool, and malformed-arg responses, asserting **balanced raw `content_block_start`/`content_block_stop`** (Anthropic) and correct terminators (`[DONE]` / `message_stop`).

## Degradation matrix (invariant 1)

| Condition | Outcome |
|---|---|
| `cascade` not enabled, or Layer 1 not `ambiguous` | Layer 0/1 decision stands |
| no `auto_low` or no `auto_high` target (plan `null`) | Layer-0 `default` |
| cheap chain fails, or cheap answer bad | escalate: strong ++ default (reliable-core rescue) |
| cheap deadline exceeded | escalate |
| client disconnects during the cheap attempt | stop; no strong call, no strong row |
| `evaluateQuality` throws | fail open → deliver cheap; `quality_signal=null` |
| escalation chain (strong ++ default) all fail | one `status=error` row |
| cheap replay pre-materialization fails (before any byte) | **escalate** (a valid cheap answer never becomes a client error) |

## Risks / trade-offs

- **Cheap-tier streaming latency** — a streaming client sees a passing cheap answer only after it fully buffers; inherent to cheap-first. The escalated path streams live.
- **Worst-case fan-out** — cascade may attempt up to `|auto_low|` (≤5) + `|auto_high| + |default|` (≤10) upstream calls, only along failures; the FrugalGPT bargain saves on the majority that pass at cheap.
- **Overlapping cheap/strong config** — if `auto_low` and `auto_high` resolve to the same model, escalation re-calls it (wasteful, not incorrect); a tenant configures distinct cheap/strong tiers. Left to configuration, not de-duplicated.
- **Coarse quality score** — capability failures only (empty/malformed/error/filtered); finer verifier scoring is a declared follow-up (the numeric `quality_signal` column keeps it open).
