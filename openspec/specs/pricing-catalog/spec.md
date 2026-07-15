# pricing-catalog Specification

## Purpose
TBD - created by archiving change add-pricing-catalog. Update Purpose after archive.
## Requirements
### Requirement: A provider-namespaced, effective-dated, append-only price catalog

The system SHALL maintain a global (non-tenant) `model_prices` catalog keyed by a **provider-namespaced** `model_key` (`"<family>:<canonical_model_id>"`), holding USD input/output unit prices (per 1M tokens), optional cache-read/cache-write prices, capability flags (context window, tools/vision/reasoning), an `is_free` flag, a `source` (`bundled`|`refresh`|`manual`), and a `valid_from` timestamp. The catalog SHALL be **append-only** — a price change is a new `valid_from` row; existing rows are never updated or deleted (invariant 4, §7.7). A unique `(model_key, valid_from)` constraint SHALL make re-applying a version idempotent. Prices are USD (a single-currency invariant); the table SHALL enforce `input/output/cache prices ≥ 0` and `is_free ⇒ input = 0 AND output = 0`, and the service SHALL reject non-finite rates and require input+output together. The catalog SHALL be exposed through the persistence port as a non-owned `pricing` accessor (no update/delete of price rows) and land with a Drizzle migration that runs on boot.

#### Scenario: History cannot be rewritten

- **WHEN** a price changes for a model
- **THEN** a new row with a later `valid_from` is inserted and the prior row is unchanged
- **AND** the persistence surface offers no update/delete of a price row, and a re-applied `(model_key, valid_from)` is an idempotent no-op

#### Scenario: Price-integrity constraints hold

- **WHEN** a version is inserted
- **THEN** a negative or non-finite price is rejected, and an `is_free` version with a non-zero price is rejected

### Requirement: One shared canonicalizer makes catalog keys and lookup keys byte-identical

The system SHALL key the catalog and resolve lookups through a single `canonicalModelKey(family, modelId)` used by BOTH the LiteLLM parser and `deriveModelKey`, so a catalog row's key and a tenant model's derived key are byte-identical or a family (e.g. Gemini, OpenRouter) resolves unknown. `family` SHALL be a LiteLLM `litellm_provider` value; `modelId` SHALL be lower-cased with exactly one leading `"<family>/"` stripped (LiteLLM keys `gemini/gemini-1.5-pro` while a provider `/models` returns `gemini-1.5-pro`). `deriveModelKey(providerBaseUrl, externalModelId)` SHALL map the provider host to that exact family (unknown host → null); a model whose host is not a known family SHALL NOT receive a bundled price by bare model-id match.

#### Scenario: A reseller/custom host does not inherit a well-known price

- **WHEN** two providers expose `gpt-4o` — one at `api.openai.com`, one at a custom/reseller host
- **THEN** the `api.openai.com` model resolves to the `openai:gpt-4o` catalog entry, and the custom-host model derives a null key (uses its own entered price, or unknown)

#### Scenario: Prefixed LiteLLM keys round-trip with bare provider ids

- **WHEN** LiteLLM ships `gemini/gemini-1.5-pro` and a Gemini provider (`generativelanguage.googleapis.com`) syncs the model id `gemini-1.5-pro`
- **THEN** both produce the identical `model_key` `gemini:gemini-1.5-pro` (the parser strips the `gemini/` prefix; the host maps to family `gemini`), so the lookup hits

### Requirement: Point-in-time lookup returns the version then in effect, monotonically

The system SHALL provide `priceAt(modelKey, at)` returning the version with the greatest `valid_from ≤ at` (or null). ALL insertion — seed, refresh, and manual override — SHALL go through one write path serialized by the persistence advisory-lock/transaction facility, re-reading `latest` inside the lock and enforcing **strict monotonicity** per key (a `valid_from ≤ latest` is skipped, so nothing backdates history). Refresh and manual override SHALL use the **server-observed instant** inside the lock (not a client-supplied time); the boot seed SHALL use `BUNDLED_CATALOG_VERSION`. A past lookup's result therefore never changes.

#### Scenario: A lookup returns the effective version, not the latest

- **WHEN** a model has versions at `T1 < T2` and a lookup is made at `T` with `T1 ≤ T < T2`
- **THEN** the `T1` version is returned; a lookup `≥ T2` returns `T2`; a lookup before `T1` returns null

#### Scenario: Backdating that would rewrite history is refused

- **WHEN** an insertion is attempted with a `valid_from` at or before the key's latest version
- **THEN** it is refused/skipped (append is monotonic), so no past lookup changes

### Requirement: The catalog is sourced from LiteLLM (bundled snapshot + live refresh)

The system SHALL source pricing/capability data from LiteLLM's `model_prices_and_context_window.json` (§7.7). A pure `parseLiteLlmCatalog(json)` SHALL map each chat/completion entry to a catalog row: `model_key = "<litellm_provider>:<model>"` (LiteLLM's `litellm_provider` is the authoritative namespace), input/output/cache prices converted from LiteLLM's per-token cost to per-1M USD, `context_window` from `max_input_tokens`, capability flags from `supports_*`, and `is_free` when the cost is zero; non-chat modes and malformed entries SHALL be skipped. The **bundled** catalog SHALL be a committed snapshot produced by this parser.

#### Scenario: LiteLLM entries map to namespaced per-1M rows

- **WHEN** a LiteLLM entry `{ "gpt-4o": { input_cost_per_token: 0.0000025, litellm_provider: "openai", mode: "chat", max_input_tokens: 128000, supports_vision: true } }` is parsed
- **THEN** it becomes `model_key: "openai:gpt-4o"`, `input_price_per_1m: 2.5`, `context_window: 128000`, `supports_vision: true`
- **AND** an `embedding`-mode or malformed entry is skipped

### Requirement: A bundled catalog is seeded on boot through the same locked apply path

The system SHALL seed the bundled catalog (namespaced keys covering the §8 BYOK providers plus a curated **free** set marked `is_free`, with a `BUNDLED_CATALOG_VERSION` UTC instant) into `model_prices` on boot (after migrations, before serving) through the **same locked, monotonic, manual-respecting apply path** as refresh/override — so it is idempotent (re-boots and concurrent multi-instance boots insert no duplicates), a bundle-version bump appends forward, an older/rolled-back bundle is skipped, and it **never supersedes a manual override**. Prices come from this bundled table, not provider `/models` (invariant 4).

#### Scenario: Boot seeds once, is monotonic, and respects overrides

- **WHEN** the app boots against a fresh database (and again on a second boot)
- **THEN** the bundled prices — including `is_free: true` free-set entries — are present before traffic is served, with no duplicates on the second boot
- **AND** a boot after an operator override does not overwrite that override, and a rolled-back (older-version) bundle inserts nothing

### Requirement: Price resolution is pure, falls back custom → local → catalog → unknown, and signals unknown distinctly

The system SHALL provide a pure `resolveModelPrice(input, catalogRow) → PriceSnapshot | null` (no DB, no clock) with precedence: (1) the `Model` row's explicit user-entered prices (`source: model`); else (2) `local` provider → free (`0/0`, `source: local`); else (3) `catalogRow` (`source: bundled|refresh|manual`); else (4) **null = price unknown**. The `PriceSnapshot` SHALL carry `{ priceVersionId, modelKey, input/output prices, nullable cache-read/write prices, isFree, source, validFrom }` so #11 can snapshot the exact rates + provenance. A null (unknown price) SHALL be a **distinct signal from `usage_estimated`** (missing token usage); this layer SHALL compute no request cost and SHALL NOT guess a price. This helper SHALL live in `@polyrouter/shared/server` so #11's data-plane cost path resolves identically.

#### Scenario: Custom wins; local is free; else catalog; else unknown

- **WHEN** a `Model` carries explicit prices → those are returned (`source: model`)
- **AND** a `local` model with no explicit prices → free (`0/0`, `source: local`)
- **AND** a known model with no explicit prices → the catalog version supplied for the request time (with its version id + rates)
- **AND** an unknown model with no catalog entry and no explicit prices → null (unknown price — distinct from `usage_estimated`; no cost guessed)

### Requirement: Refresh (incl. a guarded LiteLLM pull) and manual override only append

The system SHALL provide a refresh that applies (a) the bundled catalog, (b) an **admin-supplied catalog body**, or (c) a **live LiteLLM pull** from a configured URL — inserting a new `valid_from` version only for models whose price/flags changed (no-op otherwise) and **skipping any key whose latest version is `source: manual`** (an operator override persists), through the shared locked apply path. A manual override SHALL append a single `source: manual` version at the server clock. Neither SHALL mutate an existing row. The LiteLLM pull SHALL fetch through #4's SSRF guard (connect-time IP validation with **no loopback exception**, `redirect: 'manual'` with **any 3xx rejected**, a request **timeout**, and a **max-body-size cap enforced while streaming** — never buffering an unbounded body) and parse defensively (no JSON content-type requirement — bounded parse); a private/metadata URL, an oversized body, a non-2xx, a timeout, or non-JSON SHALL be refused with the response cancelled and no partial apply.

#### Scenario: Refresh appends on change, respects overrides, never rewrites

- **WHEN** a refresh supplies a changed price for a model whose latest is not a manual override
- **THEN** a new version is appended and the prior version stays queryable at its old timestamp
- **AND** a refresh entry matching the latest inserts nothing, and a key whose latest is a manual override is skipped

#### Scenario: A manual override appends and persists

- **WHEN** an operator overrides a model's price
- **THEN** a new `source: manual` version is appended (server-clock `valid_from`) and prior versions are unchanged

#### Scenario: The LiteLLM pull is SSRF-guarded and bounded

- **WHEN** a LiteLLM refresh is triggered against a URL that resolves to a private/metadata address, or returns an oversized or non-JSON body
- **THEN** the fetch is refused (SSRF error / size-cap / parse error) before any version is written — no partial apply
- **AND** a successful pull of the real LiteLLM JSON appends only the changed versions

### Requirement: A session-authenticated pricing API; mutations require an admin on a self-hosted instance

The system SHALL expose `api/pricing`: listing the current catalog and looking up an effective price require an authenticated session and expose no tenant/credential data. The mutating operations (override, refresh) SHALL require the caller to be an **admin** (via `IdentityPort.isAdmin(userId)`, the `user.role` column) **and** `MODE=selfhosted` — in cloud mode the global-catalog mutations SHALL be disabled (managed out-of-band). Mutations SHALL only append versions.

#### Scenario: Reads need a session; mutations need a self-host admin

- **WHEN** an authenticated non-admin lists the catalog or looks up a price
- **THEN** it succeeds
- **AND** a non-admin (or, under `MODE=cloud`, any caller) attempting an override/refresh is rejected, while a self-host admin succeeds (appending a version)

#### Scenario: Listing returns the current catalog

- **WHEN** the catalog is listed
- **THEN** it returns the latest version per `model_key` with `is_free` and capability flags, and no future-dated row is shown as current
- **AND** it contains no tenant/credential data

