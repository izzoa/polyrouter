## MODIFIED Requirements

### Requirement: One shared canonicalizer makes catalog keys and lookup keys byte-identical

The system SHALL key the catalog and resolve lookups through a single `canonicalModelKey(family, modelId)` used by BOTH the LiteLLM parser and `deriveModelKey`, so a catalog row's key and a tenant model's derived key are byte-identical or a family (e.g. Gemini, OpenRouter) resolves unknown. `family` SHALL be a LiteLLM `litellm_provider` value; `modelId` SHALL be lower-cased with exactly one leading `"<family>/"` stripped (LiteLLM keys `gemini/gemini-1.5-pro` while a provider `/models` returns `gemini-1.5-pro`). `deriveModelKey(providerBaseUrl, externalModelId)` SHALL map the provider host to that exact family (unknown host → null); a model whose host is not a known family SHALL NOT receive a bundled price by bare model-id match. The host→family map SHALL cover the spec-§8 first-class BYOK provider families, using the LiteLLM `litellm_provider` value for each: DashScope/Qwen (`dashscope`), Moonshot/Kimi (`moonshot`), MiniMax (`minimax`), and Zhipu/Z.ai GLM (`zai`) — so those providers derive a resolvable key rather than null. Because the catalog is USD, ONLY the international/USD-billed endpoints for those families SHALL be mapped (e.g. `dashscope-intl.aliyuncs.com`, `api.moonshot.ai`, `api.minimax.io`, `api.z.ai`); the China-domestic endpoints that bill in a different currency (`dashscope.aliyuncs.com`, `api.moonshot.cn`, `api.minimax.chat`, `open.bigmodel.cn`) SHALL remain unmapped (→ null / price unknown) rather than record a currency-wrong cost — invariant 4's "unknown rather than wrong".

#### Scenario: A reseller/custom host does not inherit a well-known price

- **WHEN** two providers expose `gpt-4o` — one at `api.openai.com`, one at a custom/reseller host
- **THEN** the `api.openai.com` model resolves to the `openai:gpt-4o` catalog entry, and the custom-host model derives a null key (uses its own entered price, or unknown)

#### Scenario: Prefixed LiteLLM keys round-trip with bare provider ids

- **WHEN** LiteLLM ships `gemini/gemini-1.5-pro` and a Gemini provider (`generativelanguage.googleapis.com`) syncs the model id `gemini-1.5-pro`
- **THEN** both produce the identical `model_key` `gemini:gemini-1.5-pro` (the parser strips the `gemini/` prefix; the host maps to family `gemini`), so the lookup hits

#### Scenario: A §8 BYOK international host derives its family key; a CNY host stays unknown

- **WHEN** a Qwen BYOK provider at the international `dashscope-intl.aliyuncs.com` serves model id `qwen-max`
- **THEN** `deriveModelKey` returns `dashscope:qwen-max` (not null), so the bundled/refresh catalog entry for that key resolves and the request records a non-null cost
- **AND** a provider on the CNY-domestic `dashscope.aliyuncs.com` derives a null key (price unknown), never inheriting the USD catalog price

### Requirement: A bundled catalog is seeded on boot through the same locked apply path

The system SHALL seed the bundled catalog (namespaced keys covering the §8 BYOK providers plus a curated **free** set marked `is_free`, with a `BUNDLED_CATALOG_VERSION` UTC instant) into `model_prices` on boot (after migrations, before serving) through the **same locked, monotonic, manual-respecting apply path** as refresh/override — so it is idempotent (re-boots and concurrent multi-instance boots insert no duplicates), a bundle-version bump appends forward, an older/rolled-back bundle is skipped, and it **never supersedes a manual override**. The bundled snapshot SHALL contain at least one priced row for each spec-§8 first-class BYOK provider family (including DashScope/Qwen, Moonshot/Kimi, MiniMax, and Zhipu/Z.ai GLM), so those providers are priceable out of the box. Prices come from this bundled table, not provider `/models` (invariant 4).

#### Scenario: Boot seeds once, is monotonic, and respects overrides

- **WHEN** the app boots against a fresh database (and again on a second boot)
- **THEN** the bundled prices — including `is_free: true` free-set entries — are present before traffic is served, with no duplicates on the second boot
- **AND** a boot after an operator override does not overwrite that override, and a rolled-back (older-version) bundle inserts nothing

#### Scenario: The seed covers every §8 BYOK family

- **WHEN** the bundled catalog is seeded on boot
- **THEN** `model_prices` contains at least one row per spec-§8 BYOK family (DashScope/Qwen, Moonshot/Kimi, MiniMax, Zhipu/Z.ai GLM), so a BYOK provider in one of those families resolves a catalog price without a live refresh

### Requirement: Price resolution is pure, falls back custom → local → catalog → unknown, and signals unknown distinctly

The system SHALL provide a pure `resolveModelPrice(input, catalogRow) → PriceSnapshot | null` (no DB, no clock) with precedence: (1) the `Model` row's explicit user-entered prices (`source: model`) **only when the provider kind is `custom` or `local`** — a model-own price SHALL NOT be honored for an `api_key`/`subscription` provider (whose prices come from the catalog), so a stale price left over from a former kind, or one restored by a request racing a kind change, can never override the catalog with a wrong cost; else (2) `local` provider → free (`0/0`, `source: local`); else (3) `catalogRow` (`source: bundled|refresh|manual`); else (4) **null = price unknown**. The `PriceSnapshot` SHALL carry `{ priceVersionId, modelKey, input/output prices, nullable cache-read/write prices, isFree, source, validFrom }` so #11 can snapshot the exact rates + provenance. A null (unknown price) SHALL be a **distinct signal from `usage_estimated`** (missing token usage); this layer SHALL compute no request cost and SHALL NOT guess a price. This helper SHALL live in `@polyrouter/shared/server` so #11's data-plane cost path resolves identically.

#### Scenario: Custom wins; local is free; else catalog; else unknown

- **WHEN** a `custom`/`local` `Model` carries explicit prices → those are returned (`source: model`)
- **AND** a `local` model with no explicit prices → free (`0/0`, `source: local`)
- **AND** a known model with no explicit prices → the catalog version supplied for the request time (with its version id + rates)
- **AND** an unknown model with no catalog entry and no explicit prices → null (unknown price — distinct from `usage_estimated`; no cost guessed)

#### Scenario: A model price on an api_key/subscription provider does not override the catalog

- **WHEN** an `api_key` (or `subscription`) provider's model carries explicit user-entered prices (e.g. stale from a former `custom` kind, or written by a request racing a kind change)
- **THEN** `resolveModelPrice` ignores them and returns the catalog row (`source` ≠ `model`), so the recorded cost is the catalog price, never the stale model price
