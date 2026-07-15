# Proposal: add-provider-management

> Implements **TODOS.md #7 `add-provider-management`** — spec **§2.2** (connect-providers flow), **§6.2** (management REST API: Providers list/create/test-connection/sync-models/delete, Models list/filter), **§8** (four kinds, custom endpoints never allow-listed). CLAUDE.md invariants **5** (tenant isolation), **6** (SSRF-validate every user-supplied server-fetched URL), **8** (encrypt credentials at rest; never log secrets).

## Why

Onboarding step 2 is "connect providers": the user adds an API-key / subscription / custom / local provider, the app validates it, pulls its model catalog, and shows health — all through the session-authenticated dashboard API. This is the CRUD + actions surface over the `Provider`/`Model` rows (schema from #2), wiring together three shipped pieces: #2's tenant-scoped persistence port + encryption util, #4's SSRF guard, and #6's provider adapters (`testConnection`/`listModels`). Landing it now gives the dashboard (#16) a real backend and gives #9/#10 the providers-and-models data the router routes on.

## What Changes

- **Provider CRUD** (`api/providers`, session-guarded, tenant-scoped): `list`, `create`, `get`, `update`, `test-connection`, `sync-models`, `delete`. Credentials are **encrypted at rest** with #2's `encryptSecret` (a new `PROVIDER_CREDENTIAL_KEY`), decrypted only in-memory to construct a #6 adapter, and **never returned by the API or logged** (invariant 8); responses expose a `hasCredential` boolean, never the secret. Action failures are **sanitized to a fixed `{kind,status}` message** (never the adapter's raw error body, which a hostile endpoint could use to reflect the auth header), and a `base_url` carrying userinfo (`user:pass@`) is rejected so a credential can't hide there.
- **SSRF validation of every server-fetched `base_url`** at write time and before each outbound action, via #4's `assertUrlSafe` with a `GuardContext` derived from the provider `kind` and `MODE` — a private/loopback/link-local/metadata `base_url` is rejected (except the `local` + `MODE=selfhosted` loopback exception). The custom/local endpoint is **never restricted to a known allow-list** (invariant 6, spec §8). #6's adapter re-validates at connect time (rebinding defense); this change adds the CRUD-time gate.
- **Model catalog sync**: `test-connection` builds the #6 adapter and calls `testConnection()`, mapping the result to the provider's `status`; `sync-models` calls `listModels()` and **atomically upserts `Model` rows** (a new ownership-scoped `ModelAccessor.upsertForProvider` using the existing `ON CONFLICT (provider_id, external_model_id)` index — no schema migration) with display names and `last_synced_at` — **ids only, no prices** (pricing is #8, which enriches these rows). Provider health/status is surfaced on the provider resource.
- **Models list/filter API** (`api/models`): list the tenant's models with filters (by provider, `is_free`, capability flags) for the dashboard and #9's routing UI.
- **Config**: register a `providers` config fragment with `PROVIDER_CREDENTIAL_KEY` (32-byte hex), resolved with the same dev-fallback gating as the auth secrets (a fixed dev key only on a loopback-bound, non-production, self-hosted instance).

## Capabilities

### New Capabilities

- `provider-management`: the Provider CRUD + test-connection/sync-models actions, credential encryption at rest, CRUD-time SSRF validation, the Models list/filter API, and the `PROVIDER_CREDENTIAL_KEY` config.

## Impact

- **Code:** `packages/control-plane/src/providers/**` (`providers.controller.ts`, `models.controller.ts`, `providers.service.ts`, `providers.dto.ts`, `providers.config.ts`, `providers.module.ts`) + unit tests + a provider/model management e2e, plus **one new ownership-scoped `ModelAccessor.upsertForProvider` method** on the persistence port (interface in `@polyrouter/shared/server`, impl in the control-plane database port). Registered in `app.module`. Consumes #2 (persistence port, `encryptSecret`), #4 (`assertUrlSafe`), #6 (`createProviderAdapter`) — all already data-plane/shared deps. **No schema migration** (the `provider`/`model` tables, the unique index, and the tenant-scoped repos exist from #2).
- **Downstream:** #8 attaches `ModelPrice`/capabilities to the synced `Model` rows and adds `refresh-pricing`; #9 reads the models/tiers to build routing config; #10's proxy resolves a route to a provider and constructs the adapter from these rows; #16's dashboard drives this API.

## Non-goals

- **No pricing / `ModelPrice` table / `refresh-pricing`** — #8. `sync-models` writes model ids + display names + `last_synced_at` only; prices stay null for #8 to fill.
- **No routing config (tiers/entries/rules) or proxy** — #9/#10.
- **No new SSRF range logic or new adapter behavior** — reuses #4 and #6 verbatim; this change only wires the CRUD-time SSRF gate and constructs adapters for the two actions.
- **No agent/limit/notification management** — separate changes.
