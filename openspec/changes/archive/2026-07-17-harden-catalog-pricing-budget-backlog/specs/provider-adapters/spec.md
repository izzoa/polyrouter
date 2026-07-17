## MODIFIED Requirements

### Requirement: listModels and testConnection are cheap and non-destructive

`listModels()` SHALL return `ProviderModelInfo[]` (`{ id, displayName? }`) parsed from the provider's models endpoint — raw ids only, no pricing, capabilities, or `is_free` (those are #8). When a provider's models endpoint is **cursor-paginated** (e.g. Anthropic's `has_more` + `last_id`), `listModels()` SHALL follow the pages — appending the provider's cursor query parameter until the page indicates no more — and return the accumulated ids, so a tenant with more models than one page gets a complete catalog rather than a silently truncated one. Accumulation SHALL be bounded: results are de-duplicated across pages, capped at the same total parse limit a single page uses, and the page count is bounded so a hostile or buggy `has_more`-always endpoint cannot loop unboundedly. A provider whose endpoint is not paginated SHALL behave exactly as a single fetch (no extra request). `testConnection()` SHALL perform a cheap validating call and return a structured result indicating success or a typed failure, never throwing raw and never returning the credential.

#### Scenario: testConnection reports a typed auth failure without the credential

- **WHEN** `testConnection()` runs against a provider that returns 401
- **THEN** the result indicates failure with `kind: "auth"` and contains no credential material

#### Scenario: listModels returns ids without catalog fields

- **WHEN** `listModels()` succeeds
- **THEN** the result is a list of `{ id, displayName? }` entries with no price, capability, or `is_free` fields (those are attached in #8)

#### Scenario: listModels follows cursor pagination to a complete catalog

- **WHEN** a provider's models endpoint returns a first page with a "more pages" indicator and a next cursor, then a final page with no more
- **THEN** `listModels()` issues the follow-up request(s) carrying the cursor and returns the ids from all pages (de-duplicated), not just the first page
- **AND** a provider whose response indicates no further pages (or that declares no pagination) is fetched exactly once
