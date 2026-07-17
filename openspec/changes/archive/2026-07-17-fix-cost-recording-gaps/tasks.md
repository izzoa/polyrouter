## 1. E5.1 — Shutdown flush drains the queue

- [x] 1.1 In `log-writer.ts`, add a `flushPromise?: Promise<void>` field; rewrite `flush()` to coalesce (`if (this.flushing) return this.flushPromise`), then set `flushing`, run a `flushOnce()` body, and clear `flushing` in `.finally`. `flushOnce()` splices BOTH queues up front (before any await) so a parent log + its child attempt enqueued during a write stay in the same cycle (no FK-driven drop).
- [x] 1.2 Add a per-op timeout so termination is guaranteed: add `opTimeoutMs` to `LogWriterConfig` (default 5000) and wrap each attempt's `toRow`+`insertMany` in `writeGroup`/`writeAttemptGroup` with a reject-on-timeout race; a timed-out op is retried (same ids → conflict-ignore, no double-count) and, after the retry budget, counted-as-dropped.
- [x] 1.3 Add a private `drain()` that loops `await this.flush()` while `this.flushing || queue.length || attemptQueue.length`; call it from `onApplicationShutdown` (after `clearInterval`).
- [x] 1.4 Unit tests in `log-writer.spec.ts`: (a) a deferred `insertMany` makes `flush()` pending; enqueue another draft; call `onApplicationShutdown()`; resolve; assert a second `insertMany` carried the late draft; (b) a **never-resolving** `insertMany` → `onApplicationShutdown()` still terminates within the op-timeout×retry bound and counts the rows as dropped (never hangs); (c) a late (log + its attempt) pair enqueued during the first write are both written (no FK drop).

## 2. E5.2 — Record the cancelled cascade cheap leg

- [x] 2.1 In `proxy.service.ts` `cascadeCompletion`, replace `if (signal.aborted) throw toProxyError(cheap.error)` with: record one row via `servedFrom(p, c.cheap.meta, 0, 'cascade: client disconnected during cheap attempt', null, cheap.failures)` + `{ status:'error', outputChars:0, escalated:false, qualitySignal:null }`, THEN throw. No `notifyFailed`, no `recordCheapAttempt`.
- [x] 2.2 Same in `cascadeStream` (the `providerErrorToProxy` branch).
- [x] 2.3 e2e in `cascade-routing.e2e-spec.ts`: destroy the client socket during the cheap leg (`oai-hang`-style), flush the writer, assert exactly one `request_log` row (`status='error'`, `escalated=false`), zero `request_attempt` rows, **no strong-tier upstream call** (stub call count), and **no provider-failure notification** emitted.

## 3. E5.3 — BYOK family hosts + bundled rows

- [x] 3.1 In `resolve.ts` `PROVIDER_FAMILY_HOSTS`, add **only the USD international endpoints**: `dashscope-intl.aliyuncs.com`→`dashscope`, `api.moonshot.ai`→`moonshot`, `api.minimax.io`/`api.minimaxi.com`→`minimax`, `api.z.ai`→`zai`, `api.cohere.com`→`cohere`. Do NOT map the CNY-domestic hosts (`dashscope.aliyuncs.com`, `api.moonshot.cn`, `api.minimax.chat`, `open.bigmodel.cn`) — they bill in CNY and would record a currency-wrong cost; leave them null (unknown-rather-than-wrong).
- [x] 3.2 In `bundled-catalog.ts` `LITELLM_SNAPSHOT`, add real per-token rows (verified against LiteLLM): `qwen-max`/`qwen-plus` (dashscope), `kimi-k2-0905-preview` (moonshot), `MiniMax-M2` (minimax), `glm-4.5`/`glm-4.5-air` (zai), `grok-4`/`grok-3-mini` (xai), `command` (cohere). Bump `BUNDLED_CATALOG_VERSION`.
- [x] 3.3 Table-driven unit test on `deriveModelKey` (each supported host alias → expected key, and each unmapped CNY host → null); a `resolveForModel`/pricing-catalog e2e asserting ≥1 seeded row per §8 BYOK family (query `model_prices` for `dashscope:`/`moonshot:`/`minimax:`/`zai:` keys) resolves a non-null price for a `dashscope-intl.aliyuncs.com` + `qwen-max` provider.

## 4. E5.4 — Stale model prices never override the catalog for a known provider

- [x] 4.1 **Primary (central, race-free):** in `resolve.ts` `resolveModelPrice`, gate precedence #1 on kind — honor the model-own price only when `input.providerKind === 'custom' || input.providerKind === 'local'`; for `api_key`/`subscription` fall through to the catalog. A stale/raced model price on a known provider can then never produce a wrong cost.
- [x] 4.2 **Secondary (UI consistency, non-critical):** add `models.clearPricingForProvider(principal, providerId): Promise<number>` (ModelAccessor + `database/port.ts`, one owner-scoped UPDATE → `inputPricePer1m=null, outputPricePer1m=null, isFree=false`); call it from `ProvidersService.update` when `existing.kind ∈ {custom,local}` and `nextKind ∈ {api_key,subscription}` so `GET /api/models` doesn't show a now-ignored price.
- [x] 4.3 Unit test on `resolveModelPrice`: an `api_key`/`subscription` input WITH model prices resolves the catalog row (`source` ≠ `model`), while `custom`/`local` still honors the model price. e2e: create a `custom` provider + a user-priced model, PATCH kind→`api_key`, assert `GET /api/models` shows cleared prices AND a subsequent request prices from the catalog (`source ≠ 'model'`); a within-custom update leaves prices intact.

## 5. Verification & wrap-up

- [x] 5.1 `npm run build && npm run lint && npm run typecheck` clean.
- [x] 5.2 `npm test -w packages/shared -w packages/control-plane` green (new log-writer + pricing units); `npm run test:e2e -w packages/control-plane` green (cascade-cancel, pricing-family, provider kind-change).
- [x] 5.3 Changeset (user-facing: BYOK pricing coverage + `BUNDLED_CATALOG_VERSION` bump + stale-price clear on kind change).
- [x] 5.4 Update `TODOS.md` board + mark E5 tasks ✅ in `FABLE_AUDIT.md` after archive.
