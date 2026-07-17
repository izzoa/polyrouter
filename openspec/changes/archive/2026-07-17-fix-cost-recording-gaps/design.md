## Context

Four independent cost-completeness gaps, all under the already-correct invariant-4 machinery
(immutable per-row snapshots, append-only catalog). Each silently under-counts the spend record.

## Goals / Non-Goals

**Goals:** no request-log row is lost at shutdown without being counted; a cancelled cascade cheap leg
is recorded; the §8 BYOK families are priceable from the bundled catalog; a kind change can't leave a
stale price that overrides the catalog.

**Non-Goals:** changing the cost formula, the snapshot discipline, or the LiteLLM refresh mechanism;
the adjacent backlog A-13 (refresh `validate()` skip-and-log), A-14 (per-row insert fallback), A-15
(cascade escalates on `bad_request`), A-16 (weekly-spend µ$ rounding) — deferred to the Appendix-A sweep.

## Decisions

### E5.1 — Coalescing flush + shutdown drain loop

Replace the `if (this.flushing) return` early-exit with a coalescing flush that returns the in-flight
promise, plus a `drain()` used by shutdown that loops until both queues are empty:

```
private flushPromise: Promise<void> | undefined;

async flush(): Promise<void> {
  if (this.flushing) return this.flushPromise;                    // coalesce onto in-flight
  if (this.queue.length === 0 && this.attemptQueue.length === 0) return;
  this.flushing = true;
  this.flushPromise = this.flushOnce().finally(() => { this.flushing = false; });
  return this.flushPromise;
}
private async drain(): Promise<void> {
  while (this.flushing || this.queue.length > 0 || this.attemptQueue.length > 0) {
    await this.flush();
  }
}
async onApplicationShutdown(): Promise<void> { clearInterval(...); await this.drain(); }
```

`flushOnce()` splices BOTH queues up front (before any await) — clink round 1: today it splices logs,
awaits their write, THEN splices attempts, so a cascade log + its attempt enqueued during that await
land in different flush cycles → the child attempt's FK to its not-yet-written parent fails and the
row is (avoidably) dropped. Snapshotting both atomically keeps a parent+child pair in the same cycle.

**Bounded termination (clink round 1):** the retry loop only advances on a *rejection*, but the pg pool
has no `statement_timeout`, so a hung DB op never settles → `flushPromise` stays pending forever and
`onApplicationShutdown` exceeds its grace → SIGKILL (the original silent-loss mode). Fix: wrap each
INDIVIDUAL DB op — each per-draft price lookup (`resolveForModel`, which does a `priceAt` query) AND
each batch `insertMany` — in a per-op timeout (`opTimeoutMs`, new `LogWriterConfig` field, generous
default 5s) that rejects on expiry (clink round 3: wrapping the *whole owner group* under one deadline
would false-drop a large healthy group of thousands of sequential lookups — the bound must be per-op,
so a large group's total time is unbounded but each op is fast). A timed-out op fails its attempt,
which retries with the SAME row ids (conflict-ignore → no double-count if it later commits), and after
the retry budget the rows are counted-as-dropped (never silent). `drain()` is then bounded by roughly
`(maxRetries+1) × (opTimeoutMs + backoff)` per owner group × both ledgers, so it always terminates and
**the recording-completeness accounting (write-or-count-as-dropped) completes before shutdown proceeds**
— which is exactly the audit's acceptance. Note the JS timeout abandons the wait but does not *cancel*
the pg query (no `AbortSignal` on the driver call); a genuinely wedged DB connection could still delay
the separate `pool.end()` at process teardown. Fully bounding *process exit* against a dead connection
is a pool-level concern (a writer-scoped `statement_timeout` or query cancellation) — out of scope
here and recorded as backlog; it does not affect the never-silent-loss guarantee, which is settled in
`drain()` before `pool.end()`. Steady-state callers (`enqueue`, timer) keep firing `void flush()`;
coalescing means a mid-flight one is a no-op and the next tick/threshold catches the remainder.

*Alternatives rejected:* awaiting every timer flush (serializes throughput needlessly); a pool-wide
`statement_timeout` (broader blast radius — would break long analytics queries).

### E5.2 — Record the cancelled cascade cheap leg

Both `if (signal.aborted)` branches record one row before throwing, mirroring the non-cascade cancel
row shape but WITHOUT `notifyFailed` (a client disconnect is breaker-neutral and not a provider fault):

```
this.recorder.record(
  this.servedFrom(p, c.cheap.meta, 0, 'cascade: client disconnected during cheap attempt', null, cheap.failures),
  { status: 'error', outputChars: 0, escalated: false, qualitySignal: null },
);
throw toProxyError(cheap.error);   // (providerErrorToProxy in the stream path)
```

`signal` is the PURE client signal, so this branch is client-disconnect only (the cheap-deadline is a
separate composed timeout that still escalates). No `request_attempt` ledger row (no billed cheap call
was superseded — the cheap leg itself was aborted), matching the acceptance criterion.

### E5.3 — BYOK family hosts + bundled rows (LiteLLM-verified, USD-only)

Add to `PROVIDER_FAMILY_HOSTS` (host → `litellm_provider`), verified against LiteLLM's canonical
`model_prices_and_context_window.json`. **Cost-correctness rule (clink round 1):** LiteLLM's table is
USD, so ONLY the international/global endpoints — which bill in USD — are mapped. The China-domestic
endpoints (`dashscope.aliyuncs.com`, `api.moonshot.cn`, `api.minimax.chat`, `open.bigmodel.cn`) bill
in CNY at different tariffs; mapping them to the USD catalog would record a *confidently wrong* cost
(~7× off), so they are deliberately **left unmapped** (`deriveModelKey` → null → price unknown, which
invariant 4 treats as distinct-and-acceptable — "unknown rather than wrong"). A user who wants an
explicit price for a domestic endpoint configures it as a `custom` provider and sets a model-own price
(the only kind that accepts one — see E5.4's resolver gating); otherwise the cost is recorded unknown.

| host (international, USD) | family |
|---|---|
| `dashscope-intl.aliyuncs.com` | `dashscope` |
| `api.moonshot.ai` | `moonshot` |
| `api.minimax.io`, `api.minimaxi.com` | `minimax` |
| `api.z.ai` | `zai` |
| `api.cohere.com` (adds to existing `api.cohere.ai`) | `cohere` |

Note the audit's guessed `zhipu` is stale — LiteLLM now namespaces GLM/Z.ai under `zai`; the audit's
`api.minimax.chat` is the CNY endpoint (its intl API host is `api.minimax.io`). Extend the bundled
snapshot with real per-token rows (same LiteLLM format the existing entries use, run through
`parseLiteLlmCatalog`): dashscope `qwen-max`/`qwen-plus`, moonshot `kimi-k2-0905-preview`, minimax
`MiniMax-M2`, zai `glm-4.5`/`glm-4.5-air`, xai `grok-4`/`grok-3-mini`, cohere `command`. Bump
`BUNDLED_CATALOG_VERSION` so it lands as a new effective-dated version. Because `canonicalModelKey`
lowercases, a `dashscope:qwen-max` bundled key matches `deriveModelKey(dashscope-intl-url, 'qwen-max')`.

### E5.4 — Clear stale model prices on kind change

**Primary fix — gate the resolver (clink round 2 makes this the correct root fix):** the real defect
is that `resolveModelPrice`'s precedence #1 (model-own price) applies even to an `api_key`/`subscription`
provider, for which the API already forbids setting a model price (`updateModelPricing` rejects
non-custom/local). So a stale model-own price left after a kind change — or *restored* by a concurrent
`updateModelPricing` racing the kind change (a TOCTOU codex found) — silently overrides the catalog.
Fix it centrally and race-free: `resolveModelPrice` SHALL honor the model-own price **only when
`providerKind ∈ {custom, local}`**; for `api_key`/`subscription` it falls straight through to the
catalog. This is a pure change to the shared resolver (invariant 4), so a stale/raced model price can
never produce a wrong cost regardless of clearing or concurrency — no row-locking, no transaction
needed for correctness.

**Secondary — clear for UI consistency (no longer correctness-critical):** `ProvidersService.update`
still clears the provider's models' `inputPricePer1m`/`outputPricePer1m`/`isFree` when kind moves from
`custom`/`local` to `api_key`/`subscription`, via a tenant-scoped `models.clearPricingForProvider`
(one owner-scoped UPDATE — inherently atomic; a failed or raced clear now only leaves a cosmetic,
resolver-ignored value, so it needs no cross-statement transaction or lock). This keeps
`GET /api/models` from showing a price the resolver won't use. Historical `request_log` snapshots keep
their own price snapshots (unaffected, invariant 4).

## Risks / Trade-offs

- **[E5.1 drain loop]** must terminate — guaranteed because shutdown stops new enqueues and the retry
  policy is bounded (drops are counted, splice empties the queue). Tested with a persistent-failure case.
- **[E5.3 wrong family = no catalog hit]** — mitigated by verifying every family/price against the live
  LiteLLM JSON; internal consistency (host-family == bundled-key family) makes the seed path correct
  regardless of upstream drift.
- **[E5.4 clears user intent]** — a user who set a price then changed kind loses it; acceptable because a
  user-set price on an `api_key`/`subscription` provider is exactly the stale-override bug, and the
  catalog now covers those families. Documented in the changeset.
- **[Accepted edges (clink round 3)]** — (a) a price written by `updateModelPricing` racing a kind change
  is ignored while the provider is `api_key`/`subscription` (the resolver gate) and is only ever honored
  if the provider is later `custom`/`local`, where a user-set price is legitimate — so it never yields a
  wrong cost; the transient GET inconsistency is cosmetic. (b) A cancelled cascade records the cheap
  tier's index-0 member (per the audit's E5.2 wording); with a multi-member cheap tier the in-flight
  member could differ, but the row is a zero-cost `status=error` cancel, so model attribution is
  best-effort, not a spend error.

## Migration Plan

Code-only; no schema migration (price columns already nullable). Rollback is a straight revert; the
`BUNDLED_CATALOG_VERSION` bump is additive (append-only catalog).

## Open Questions

None.
