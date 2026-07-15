# Proposal: add-pricing-catalog

> Implements **TODOS.md #8 `add-pricing-catalog`** — spec **§7.7** (pricing data & cost accuracy: bundled versioned table, effective-dated `ModelPrice`, refresh + manual override, custom/local pricing), **§5** (Model, ModelPrice), **§8** (curated free-models set). CLAUDE.md invariant **4** (cost is immutable — prices come from a bundled versioned table, not provider `/models`; historical cost is never recomputed against current prices).

## Why

Cost tracking is a headline feature, and provider `/models` endpoints mostly don't return prices, so the app must ship its own **bundled, versioned pricing + capability catalog** (sourced from LiteLLM, §7.7) and be able to answer "what did this model cost per token *at request time*." That effective-dated lookup is the foundation the proxy's cost-at-request-time snapshot (#11) is built on: #11 snapshots the unit prices onto each RequestLog so a later price change can't rewrite past spend (invariant 4). Landing the catalog now — before the proxy records anything — means #11 has a real price source and #9's routing can resolve free/cheap models via the catalog. This change provides the price/capability *resolution*; wiring it into #7's model listing and #9's routing is those consumers' job (this change writes nothing back onto `Model` rows).

## What Changes

- **An effective-dated, provider-namespaced `model_prices` catalog table** (schema + migration): a **global** (non-tenant) reference keyed by `"<family>:<canonical_model_id>"` (so a reseller's `gpt-4o` never inherits OpenAI's price), with USD input/output **and cache-read/write** unit prices, capability flags, an `is_free` flag, a `source` (`bundled`|`refresh`|`manual`), and `valid_from`. **Append-only, monotonic** versioning — a refresh/override inserts a **new** `valid_from` row and **never mutates history** or lets a past lookup change; CHECK constraints enforce `≥ 0` prices and `is_free ⇒ 0`. Exposed through the persistence port as a non-owned `pricing` accessor (like `users`).
- **A bundled pricing catalog** shipped with the app (namespaced curated set covering the §8 BYOK providers — OpenAI, Anthropic, Google Gemini, DeepSeek, Mistral, Groq, … — **plus a curated free-models set** marked `is_free`), and an **idempotent, multi-instance-race-safe seed-on-boot** (`OnApplicationBootstrap`) that loads it into `model_prices` without duplicating already-seeded versions.
- **A pure price resolver** (in `@polyrouter/shared/server`, reusable by #11's data-plane cost path): `deriveModelKey(providerBaseUrl, externalModelId)` maps a provider to a family (**unknown host → null**, never a wrong-provider price); `resolveModelPrice(input, catalogRow)` returns a `PriceSnapshot` by precedence Model-own-price → **local = free** → catalog → **null (price unknown — a signal distinct from `usage_estimated`)**. It carries the exact rates + version id + provenance for #11 to snapshot, computes no cost, and guesses no price.
- **An append-only refresh + manual-override management API** (`api/pricing`): reads (list/lookup) need a session; **mutations require an admin on a self-hosted instance** (`isAdmin` + `MODE=selfhosted`; cloud disables them, since the catalog is global). Refresh applies the bundled catalog, an admin-supplied catalog body, **or an admin-triggered pull of the live LiteLLM JSON — fetched through #4's SSRF guard** (guarded dispatcher, no loopback exception, timeout, max-body-size cap, defensive parse). All paths append only changed versions, are monotonic, and never clobber a manual override. Custom-model and local pricing is set through the existing `Model` row; no change to #7.

## Capabilities

### New Capabilities

- `pricing-catalog`: the effective-dated `model_prices` table + port accessor, the bundled catalog + seed-on-boot, the effective-dated price-resolution service (incl. custom/local fallback), and the refresh + manual-override management API.

## Impact

- **Code:** `packages/shared/src/server/db/schema.ts` (the `model_prices` table + types) + a generated Drizzle migration; the persistence-port `pricing` accessor + an `IdentityPort.isAdmin` method (interfaces in `@polyrouter/shared/server`, impls in the control-plane port); `packages/control-plane/src/pricing/**` (bundled catalog, `PricingService`, `PricingController`, `PricingBootstrap`, module); pure `resolveModelPrice`/`deriveModelKey` helpers in `@polyrouter/shared/server` (so #11's data-plane cost path reuses them). Registered in `app.module`.
- **Downstream:** #11's RequestLog snapshots the unit prices + version this resolves at request time (immutable cost, invariant 4); #9's routing resolves `is_free` / price via this catalog to prefer $0 models; #7's model listing resolves capabilities/prices via the catalog. This change writes nothing back onto `Model` rows — consumers resolve dynamically, so a catalog refresh can't silently drift denormalized copies.

## Non-goals

- **No RequestLog / cost computation / price snapshotting** — that is #11; this change provides the price *lookup* (and a distinct "price unknown" signal), not the recording. It computes no cost and guesses no price.
- **No *scheduled/background* pull** — an admin-triggered LiteLLM pull lands here (SSRF-guarded); a periodic/BullMQ background job is a later addition. No fetch of untrusted user input — the refresh URL is admin-configured.
- **No tenant-scoped/per-org pricing overrides and no writes to `Model` rows** — the catalog is global reference data; per-tenant custom pricing uses the existing `Model` columns; consumers (#7 listing, #9 routing) resolve capabilities/prices via the catalog in their own changes, not here. Cloud-tier per-tenant catalogs are deferred.
- **No routing/proxy changes** — #9/#10 consume this; they are separate changes.
