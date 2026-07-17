## MODIFIED Requirements

### Requirement: Refresh (incl. a guarded LiteLLM pull) and manual override only append

The system SHALL provide a refresh that applies (a) the bundled catalog, (b) an **admin-supplied catalog body**, or (c) a **live LiteLLM pull** from a configured URL — inserting a new `valid_from` version only for models whose price/flags changed (no-op otherwise) and **skipping any key whose latest version is `source: manual`** (an operator override persists), through the shared locked apply path. Each entry SHALL be **validated before it is written** (prices finite and non-negative; a free model has zero input/output price). For the **untrusted live LiteLLM pull**, a single invalid entry SHALL be **skipped and logged, not fatal** — the refresh continues and appends the remaining valid entries, so one malformed upstream row cannot abort the whole refresh and drop every other price update; the skipped count is reported. For an **explicit/trusted source** (the bundled snapshot, a manual override, or an admin-supplied catalog body) an invalid entry SHALL still fail-fast (a bad bundled table or bad operator input is worth surfacing, not silently dropping). A manual override SHALL append a single `source: manual` version at the server clock. Neither SHALL mutate an existing row. The LiteLLM pull SHALL fetch through #4's SSRF guard (connect-time IP validation with **no loopback exception**, `redirect: 'manual'` with **any 3xx rejected**, a request **timeout**, and a **max-body-size cap enforced while streaming** — never buffering an unbounded body) and parse defensively (no JSON content-type requirement — bounded parse); a private/metadata URL, an oversized body, a non-2xx, a timeout, or non-JSON SHALL be refused with the response cancelled and no partial apply.

#### Scenario: Refresh appends on change, respects overrides, never rewrites

- **WHEN** a refresh supplies a changed price for a model whose latest is not a manual override
- **THEN** a new version is appended and the prior version stays queryable at its old timestamp
- **AND** a refresh entry matching the latest inserts nothing, and a key whose latest is a manual override is skipped

#### Scenario: A manual override appends and persists

- **WHEN** an operator overrides a model's price
- **THEN** a new `source: manual` version is appended (server-clock `valid_from`) and prior versions are unchanged

#### Scenario: One invalid live-LiteLLM entry is skipped, not fatal

- **WHEN** a live LiteLLM pull contains one entry with an invalid price (negative or non-finite) alongside valid entries
- **THEN** the invalid entry is skipped (logged, counted) and the valid entries are still appended — the whole refresh is not aborted by the one bad row
- **AND** an invalid entry in a trusted/explicit source (the bundled catalog, a manual override, or an admin-supplied body) still fails-fast (surfaced as an error, not silently skipped)

#### Scenario: The LiteLLM pull is SSRF-guarded and bounded

- **WHEN** a LiteLLM refresh is triggered against a URL that resolves to a private/metadata address, or returns an oversized or non-JSON body
- **THEN** the fetch is refused (SSRF error / size-cap / parse error) before any version is written — no partial apply
- **AND** a successful pull of the real LiteLLM JSON appends only the changed versions
