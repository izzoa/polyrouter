# Tasks: add-pricing-catalog

> Build order: schema+migration → identity `isAdmin` → port accessor → pure resolver/deriveModelKey (shared) → bundled catalog + service → seed bootstrap → controller/module → tests. Cost-immutability + effective-dated + namespace tests land with the code they cover.

## 1. Schema & migration

- [x] 1.1 Add `model_prices` to `schema.ts`: `id`, `modelKey` (text, notNull — namespaced `family:id`), `inputPricePer1m`/`outputPricePer1m` (double, notNull), `cacheReadPricePer1m`/`cacheWritePricePer1m` (double, nullable), `contextWindow` (int, nullable), `supportsTools`/`Vision`/`Reasoning` (bool default false), `isFree` (bool default false), `source` (text notNull), `validFrom` (timestamptz notNull), `createdAt`; `uniqueIndex(model_key, valid_from)` (the only index); **CHECK** `input/output/cache ≥ 0` and `is_free ⇒ input=0 AND output=0`. Export `ModelPriceRow`/insert types. Document the USD-only invariant.
- [x] 1.2 Generate the migration (`npm run db:generate -w packages/control-plane`); confirm it lands in `src/database/migrations`, runs on boot, and changes no existing table.

## 2. Identity admin check

- [x] 2.1 Add `IdentityPort.isAdmin(userId): Promise<boolean>` (interface in shared) reading the `user.role` column; implement in `control-plane/src/database/port-identity.ts`. Unit/e2e: the first admin is true, a non-admin false.

## 3. Persistence-port pricing accessor

- [x] 3.1 Add a non-owned `pricing: PricingCatalog` to `PersistencePort` (shared): `priceAt(modelKey, at)`, `latest(modelKey)`, `listLatest()`, `insertVersion(entry)` (append; monotonic backstop — rejects `valid_from ≤ latest`). Types `ModelPriceRow`/`ModelPriceInput`. Global (no `principal`); **no bulk seed, no update/delete** — the service's locked `applyVersions` is the single write path.
- [x] 3.2 Implement in `port.ts`: `priceAt` (`valid_from ≤ at ORDER BY valid_from DESC LIMIT 1`), `listLatest` (`DISTINCT ON (model_key) … WHERE valid_from ≤ now ORDER BY model_key, valid_from DESC`), `latest`, `insertVersion` (append; monotonic guard). Add a port e2e: append + effective-dated `priceAt` across timestamps + monotonic (`≤ latest`) rejection.

## 4. Pure resolver, key derivation & LiteLLM parser (shared)

- [x] 4.1 Add to `@polyrouter/shared/server` (pure — no DB, no clock, no network): `canonicalModelKey(family, modelId) → string` (family = a LiteLLM `litellm_provider` value; modelId lower-cased with one leading `"<family>/"` stripped) — the SINGLE key builder used by both the parser and derivation; `PROVIDER_FAMILY_HOSTS` host→family map aligned to `litellm_provider` names (`generativelanguage.googleapis.com→gemini`, `openrouter.ai→openrouter`, …); `deriveModelKey(providerBaseUrl, externalModelId) → string | null` (host→family→`canonicalModelKey`; unknown host → null); `resolveModelPrice(input, catalogRow) → PriceSnapshot | null` (precedence model→local-free→catalog→null; `PriceSnapshot` carries priceVersionId/modelKey/rates/nullable-cache/isFree/source/validFrom; null = unknown price, distinct from usage_estimated). Add `pricing-resolve.spec.ts` (Vitest): each branch, unknown→null, cache nullable, unknown host→null, no cost computed.
- [x] 4.2 Add `parseLiteLlmCatalog(json) → BundledPrice[]` (pure): map each `mode` chat/completion entry → `model_key = canonicalModelKey(litellm_provider, name)` (strips the `<provider>/` prefix), per-token cost × 1e6 → per-1M USD (input/output/cache-read/cache-write), `context_window = max_input_tokens`, `supports_*` flags, `is_free` when cost 0; skip non-chat/`sample_spec`/malformed. Add `litellm-parse.spec.ts` (Vitest) over real LiteLLM fixtures **including Gemini/OpenRouter prefixed keys**: correct mapping/units, prefix strip, key round-trips with `deriveModelKey`, skips embeddings, tolerates missing fields.

## 5. Config, guarded LiteLLM fetch, bundled catalog & service

- [x] 5.1 Add `pricing/pricing.config.ts`: `registerConfig('pricing', …)` with `PRICING_REFRESH_URL` (default LiteLLM's raw GitHub JSON URL), `PRICING_FETCH_TIMEOUT_MS` (default 15s), `PRICING_MAX_BYTES` (default ~8 MB). Add `pricing/litellm-fetch.ts`: `fetchLiteLlmCatalog(url, { mode, timeoutMs, maxBytes, resolve? })` using #4's `assertUrlSafe` + `createGuardedDispatcher` + undici `fetch` (NOT `guardedFetch`): `redirect: 'manual'` with **any 3xx rejected**, `AbortSignal` timeout, **size cap enforced while streaming** (abort when bytes exceed the cap — never buffer unbounded), **no content-type requirement** (bounded JSON parse), and on ANY failure cancel/destroy the body + close the dispatcher before throwing. Returns parsed JSON or throws. Add `undici` to control-plane deps. Add `litellm-fetch.spec.ts`: an injected `resolve` returning a metadata/private IP is refused (SsrfError) before bytes; an over-cap streamed body is aborted; a loopback URL is refused (no loopback exception); a `text/plain` JSON body still parses.
- [x] 5.2 Add `pricing/bundled-catalog.ts`: `BUNDLED_CATALOG_VERSION` (a UTC `Date`) + `BUNDLED_PRICES: BundledPrice[]` — a committed snapshot produced by `parseLiteLlmCatalog` over a vendored LiteLLM JSON subset covering the §8 BYOK providers (OpenAI, Anthropic, Gemini, DeepSeek, Mistral, Groq, …) + a curated `is_free` free set (kept small/reviewable). A content change MUST bump the version.
- [x] 5.3 Implement `pricing/pricing.service.ts` with ONE locked write path `applyVersions(entries, validFrom, source)` (via `PersistenceFacilities.withAdvisoryLock`/`withTransaction`: per entry, re-read `latest`; skip if `latest.source==='manual'` (except a new manual), skip if `valid_from ≤ latest`, skip if unchanged; else `insertVersion`). Methods: `priceAt`, `resolveForModel(model, providerBaseUrl, providerKind, at)` (deriveModelKey → priceAt → resolveModelPrice), `listCatalog()`, `override(modelKey, prices, now)` (validate finite/≥0/is_free⇒0 → applyVersions(source:manual, now)), `refresh({ source: bundled|body|litellm, entries?, url }, now)` (litellm → `fetchLiteLlmCatalog(injectable)` + `parseLiteLlmCatalog`; applyVersions at server `now`), `seed()` (applyVersions(BUNDLED_PRICES, BUNDLED_CATALOG_VERSION, bundled)). An injectable `fetchImpl` seam for the litellm path. Add `pricing.service.spec.ts` (fake port/facilities + injected fetch): applyVersions is monotonic + skips manual (seed after override doesn't clobber; older bundle no-ops), refresh appends only on change, override appends + rejects bad values, resolveForModel fallback + unknown-host→unknown, a litellm refresh over a fixture appends changed rows.

## 6. Seed on boot

- [x] 6.1 Add `pricing/pricing.bootstrap.ts` (`OnApplicationBootstrap`) calling `seed()` before serving; idempotent + multi-instance-race-safe via the advisory-locked `applyVersions`. Log the added count (no secrets).

## 7. Management API & wiring

- [x] 7.1 Implement `pricing/pricing.controller.ts` (`api/pricing`): `GET /` (list — session), `GET /:modelKey` (`?at=` — session), `POST /:modelKey/override` (admin + selfhosted), `POST /refresh` (admin + selfhosted; body `{ source: bundled|body|litellm, entries? }` — `litellm` triggers the guarded LiteLLM pull). Gate mutations via `isAdmin` + `MODE=selfhosted` (cloud → 403). `class-validator` DTOs (finite prices, is_free consistency, source enum).
- [x] 7.2 Add `pricing/pricing.module.ts` (imports `DatabaseModule`; service + bootstrap + controller) and register in `app.module`. Confirm boot seeds and the routes resolve.

## 8. E2E (real Postgres)

- [x] 8.1 Add `test/pricing/pricing-catalog.e2e-spec.ts`: boot seeds the bundled catalog (idempotent on a second boot; free set present with `is_free`); `priceAt` returns the effective version across timestamps; a manual override (self-host admin) appends a new version and a **past lookup still returns the old price** (immutability); a backdated insert is refused; a refresh appends only on change and **skips a manual override**; a **`source: litellm` refresh with an injected `fetchImpl` returning a LiteLLM fixture appends rows** (the real guarded fetch's SSRF/size rejection is covered by `litellm-fetch.spec`, since a real success can't hit loopback); a non-admin override/refresh is rejected and a read succeeds; under `MODE=cloud` mutations are disabled; two `gpt-4o` providers (known vs custom host) resolve to different (or no) catalog price.

## 9. Definition of done

- [x] 9.1 `npm test -w packages/shared` (resolver/deriveModelKey), `npm test -w packages/control-plane` (service + port + identity), and `npm run test:e2e -w packages/control-plane` (pricing e2e incl. effective-dated + immutability + namespace + admin/self-host gating) green; `npm run build` passes; lint clean; strict TS, no `any` escapes.
- [x] 9.2 Add a changeset (`@polyrouter/shared` + `@polyrouter/control-plane` minor).
- [x] 9.3 Confirm non-goals hold (no RequestLog/cost computation, no *scheduled/background* pull, no per-tenant catalog, no writes to `Model` rows, no routing/proxy; the admin-triggered LiteLLM pull IS in scope and SSRF-guarded; #4/#6/#7 unmodified); update spec/deltas and leave the change archive-ready.
