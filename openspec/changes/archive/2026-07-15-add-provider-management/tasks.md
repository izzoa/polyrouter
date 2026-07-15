# Tasks: add-provider-management

> Build order: config → DTOs + safe shape → service (encryption, SSRF gate, adapter actions, model upsert) with unit tests → controllers → module wiring → e2e (SSRF reject, credential encryption, cross-tenant, no-secret). Tests land with the code they cover.

## 1. Config: PROVIDER_CREDENTIAL_KEY

- [x] 1.1 Add `providers/providers.config.ts`: `registerConfig('providers', z.object({ PROVIDER_CREDENTIAL_KEY: z.string().refine(32-byte-hex).optional() }))`; `resolveCredentialKey(cfg, base)` mirroring `resolveAuthSecrets` (fixed dev-fallback key only when loopback-bound + non-production + self-hosted; value never echoed). Add `providers.config.spec.ts` covering the gating matrix (prod/cloud/network-bound require a real key).

## 2. Persistence-port upsert, DTOs & safe provider shape

- [x] 2.1 Add `ModelAccessor.upsertForProvider(principal, providerId, values)` to the port: interface in `@polyrouter/shared/server` (`persistence.ts`) + impl in `control-plane/src/database/port.ts` — an ownership-checked `INSERT … SELECT (owned provider) … ON CONFLICT (provider_id, external_model_id) DO UPDATE SET display_name, last_synced_at`, returning `null` when the provider isn't the principal's. No schema migration (the unique index exists). Add a port unit/e2e test: upsert creates then updates; returns null cross-tenant; same external id under two providers stays distinct; **concurrent same-key upserts (`Promise.all`) and a duplicate id in one batch converge with no unique-constraint violation**.
- [x] 2.2 Add `providers/providers.dto.ts`: `CreateProviderDto` (`name` 1..80, `kind ∈ 4`, `protocol ∈ 2`, `baseUrl` `@IsUrl({http,https})`, optional `credential`), `UpdateProviderDto` (partial), `ListModelsQueryDto` (`providerId?`, `isFree?`, capability flags). Global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`).
- [x] 2.3 Define the `SafeProvider` shape + `toSafe(ProviderRow)` mapper (`id, name, kind, protocol, baseUrl, status, hasCredential, createdAt`) — **no `lastSyncedAt`** (not a `Provider` column) and **never `encrypted_credentials`**.

## 3. ProvidersService (+ unit tests)

- [x] 3.1 Implement `providers/providers.service.ts` with an injected `PROVIDER_ADAPTER_FACTORY` (default `createProviderAdapter`), the resolved credential key, and `MODE`. Methods: `normalizeAndGateBaseUrl(kind, baseUrl)` (parse URL; reject userinfo + query/fragment; `assertUrlSafe` with the per-kind `GuardContext`; reject `local` under `MODE=cloud`; return the normalized URL string), `buildAdapterConfig(provider)` (require non-null `baseUrl`; require a credential for `api_key`/`subscription`/`custom` — missing → clear `422`; `local` may pass `''`), `create` (gate + encrypt), `update` (fetch owned row; validate merged `nextKind`/`nextBaseUrl`; re-encrypt only if `credential` present, empty clears), `testConnection(provider)` (build adapter, **sanitize** result → fixed `{kind,status}` message + internal `traceId`, map → `status`), `syncModels(provider)` (adapter `listModels()` → dedupe → `db.models.upsertForProvider` per model, ids+displayName+lastSyncedAt only, no prices, no prune, return synced count, **sanitize** any adapter throw). Never log the raw result/error/config/credential **or the upstream `ProviderError.requestId`** — log only `{kind, status, internal traceId}`.
- [x] 3.2 Add `providers.service.spec.ts` (fake port + fake adapter factory + real `encryptSecret`): credential round-trips through the envelope and `toSafe` omits it; a `user:pass@host` and a query/fragment `base_url` are rejected; a private/metadata `base_url` is rejected; `local`+`cloud` rejected, `local`+`selfhosted` loopback allowed; a fake adapter whose failure `message` **and `requestId` both equal the exact credential** never leaks it into the sanitized result or logs; a missing credential on a non-local kind → `422` before any adapter call; update validates the merged tuple (`local`→`custom` w/o baseUrl rejected) and preserves/clears the credential correctly; `syncModels` upserts by `external_model_id`, writes no prices, prunes nothing.

## 4. Controllers

- [x] 4.1 Implement `providers/providers.controller.ts` (`api/providers`): `list`, `create`, `get`, `update`, `delete`, `POST :id/test-connection`, `POST :id/sync-models` — `@CurrentPrincipal()`, tenant-scoped `db.providers`, `NotFoundException` on miss, `toSafe` on every response, `Cache-Control: no-store` where a credential was in the request.
- [x] 4.2 Implement `providers/models.controller.ts` (`api/models`): `list` with `providerId`/`isFree`/capability filters over `db.models.listForPrincipal`, credential-free.

## 5. Module wiring

- [x] 5.1 Add `providers/providers.module.ts` (both controllers + `ProvidersService` + the `PROVIDER_ADAPTER_FACTORY` default provider) and import it in `app.module`. Confirm the global `SessionGuard` covers `/api/providers` + `/api/models` and `PERSISTENCE_PORT` resolves.

## 6. E2E (real Postgres/Redis)

- [x] 6.1 Add `test/providers/provider-management.e2e-spec.ts` (Supertest, authenticated session via the existing harness, fake adapter factory bound in the test module): create with a credential → `encrypted_credentials` is an envelope and no response/log contains the credential; a `user:pass@` and a private/metadata `base_url` → `422`; a `local` loopback under selfhosted accepted, under cloud rejected; `test-connection` sets status and a reflected-credential failure stays sanitized; `sync-models` creates/updates model rows with null prices; deleting a provider cascades away its models + routing entries; cross-tenant `get`/`update`/`delete`/`sync-models`/`test-connection` → `404` **and never invokes the adapter factory**; `api/models` scoped + filterable.
- [x] 6.2 Add one real-factory integration case (no fake): the default `createProviderAdapter` wiring + config mapping is exercised against a loopback stub server (proves default registration, not just the fake), asserting a happy `test-connection`/`sync-models` and that a non-loopback private `base_url` is refused end-to-end.

## 7. Definition of done

- [x] 7.1 `npm test -w packages/control-plane` and `npm run test:e2e -w packages/control-plane` green (config gating, service, controllers, provider-management e2e incl. SSRF/tenant/credential); `npm run build` passes; lint clean; strict TS, no `any` escapes.
- [x] 7.2 Add a changeset (`@polyrouter/control-plane` minor) describing provider management + Models API.
- [x] 7.3 Confirm non-goals hold (no `ModelPrice`/pricing/refresh, no routing/proxy, no schema migration, #4/#6 unmodified); update spec/deltas as needed and leave the change archive-ready.
