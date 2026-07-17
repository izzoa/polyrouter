# routing-config Specification

## Purpose
TBD - created by archiving change add-routing-config. Update Purpose after archive.
## Requirements
### Requirement: Tenant-scoped tier CRUD with a protected, seeded default

The system SHALL expose session-authenticated CRUD for tiers under `/api/routing/tiers`, scoped to the authenticated principal (spec §5, §6.2; invariant 5). Every tenant always has a `default` tier (provisioned at signup); it cannot be deleted or have its key changed. Tier keys are validated and unique per owner. The nullable display fields (`display_name`, `description`) SHALL be clearable by an explicit `null` in a PATCH — they are optional/null-tolerant, so a `null` is persisted (the field is cleared), not rejected as a validation error and not silently ignored.

#### Scenario: The default tier is always present and protected

- WHEN a principal lists tiers
- THEN the response includes a tier with key `default`
- AND a request to delete the `default` tier is rejected with a clear 4xx error (it is never removed)

#### Scenario: A tier key is validated and unique per owner

- WHEN a principal creates a tier with a key that is empty, not a lowercase slug, or the reserved alias `auto`
- THEN the request is rejected with a 4xx validation error and no tier is created
- WHEN a principal creates a tier whose key already exists for that principal
- THEN the request is rejected with a clear conflict error (the unique constraint is surfaced, not a 500)

#### Scenario: A tier key is immutable; display fields are editable

- WHEN a principal patches a tier's display name or description
- THEN those fields are updated and the tier's `key` is unchanged
- AND any attempt to change `key` through the update path is ignored or rejected (never mutated)

#### Scenario: A nullable display field is cleared by an explicit null

- WHEN a principal patches a tier with `display_name: null`
- THEN the request succeeds (200) and the field is cleared to null (an explicit null on a nullable field is persisted, not rejected)

#### Scenario: Another tenant's tier is invisible by id

- WHEN principal B requests, patches, or deletes a tier owned by principal A by its id
- THEN the response is 404 (not A's row) and A's tier is unmodified

### Requirement: An ordered routing-entry chain replaced atomically within the cap

The system SHALL expose the tier↔model chain under `/api/routing/tiers/:tierId/entries`: `GET` returns entries ordered by position (position 0 = primary) with their model, and `PUT { modelIds: [...] }` atomically replaces the entire chain. Replacement enforces the **maximum of 5 models per tier** (spec §7.4), de-duplicates, requires every model to be owned by the principal, and assigns contiguous positions `0..N-1`. A model MAY appear in multiple tiers.

#### Scenario: Assign, order, and read back the chain

- WHEN a principal PUTs an ordered `modelIds` list (length 1..5) of its own models to an owned tier
- THEN the tier's entries are exactly those models at positions `0..N-1` in the given order
- AND a subsequent GET returns them position-ordered, with position 0 as the primary

#### Scenario: Reorder and unassign are the same atomic replace

- WHEN a principal PUTs the same models in a new order, or a shorter list
- THEN the stored positions reflect the new order with no gaps, and omitted models are unassigned
- AND the operation never fails on a transient duplicate-position collision (it is atomic, not row-by-row)

#### Scenario: Concurrent replacements of the same tier are serialized

- WHEN two replacements of the same tier's chain run concurrently
- THEN they are serialized (each acquires the tier row lock before deleting/inserting), one complete chain wins, and neither request fails with a position-uniqueness error or a 500

#### Scenario: The five-model cap is enforced

- WHEN a principal PUTs a list of more than 5 model ids
- THEN the request is rejected with a clear 4xx error and the tier's existing chain is unchanged

#### Scenario: Duplicate or unowned models are rejected as a unit

- WHEN a PUT list contains the same model id twice, or any model id not owned by the principal (another tenant's or nonexistent)
- THEN the whole replacement is rejected with a clear 4xx error and the tier's existing chain is unchanged (no partial write)

#### Scenario: Entries on another tenant's tier are refused

- WHEN principal B PUTs or GETs entries for a tier owned by principal A
- THEN the response is 404 and A's chain is unmodified

### Requirement: Routing-rule CRUD with a structured, write-time-validated target

The system SHALL expose CRUD for routing rules under `/api/routing/rules`, tenant-scoped, with fields `match_type` (`header`|`default`|`auto_high`|`auto_low` — the latter two bind a structural-routing confidence band, #13, to a tier/model target), `header_name` (default `x-polyrouter-tier`), `header_value`, `target`, and `priority` (default 0) (spec §5, §7.2). The `target` is a structured reference — `tier:<key>` or `model:<id>`. Target references are validated **at write time** against the caller's own tiers and models (best-effort referential integrity — see the unresolved-target contract below). `header_name` is normalized to a valid lower-cased HTTP field-name; on create, `header_name` and `priority` are optional and fall back to their defaults. An explicit JSON `null` for a **non-nullable** field (`match_type`, `header_name`, `target`, `priority`) SHALL be rejected with a 4xx validation error and leave any stored rule unchanged — it SHALL NOT be treated like an absent field (which would reach a parser/NOT-NULL column and 500, or silently rewrite the rule to a default). (`header_value` remains optional at the DTO layer, but the effective-merged validation still requires a `header` rule to carry a value, so an absent/`null` `header_value` on a `header` rule is itself a 4xx.)

#### Scenario: A header rule maps a header value to an owned target

- WHEN a principal creates a `header` rule with `header_value` set and `target` = `tier:<an existing owned tier key>` (or `model:<an existing owned model id>`)
- THEN the rule is created and returned, with `header_name` defaulting to `x-polyrouter-tier` (lower-cased) when omitted
- WHEN the target references a tier key or model id the principal does not own (or is malformed)
- THEN the request is rejected with a clear 4xx error and no rule is created

#### Scenario: match_type and header fields are validated, including the effective row after PATCH

- WHEN a principal creates a rule with a `match_type` outside {`header`,`default`,`auto_high`,`auto_low`}, a `header` rule missing `header_value`, or an invalid `header_name`
- THEN the request is rejected with a 4xx validation error
- WHEN a PATCH would leave the **effective merged** rule invalid (e.g. changing `match_type` to `header` without a `header_value`)
- THEN the PATCH is rejected and the stored rule is unchanged

#### Scenario: An explicit null for a non-nullable field is a 4xx, not a 500

- WHEN a rule create or PATCH sends an explicit `null` for `target`, `priority`, `match_type`, or `header_name`
- THEN the request is rejected with a 4xx validation error and the stored rule (on PATCH) is unchanged — never a 500 from a parser TypeError, a NOT-NULL violation, or a silent rewrite to the default header

#### Scenario: Rules are listed in a deterministic resolution order

- WHEN a principal lists rules
- THEN they are returned in the order the proxy (#10) evaluates them: by `priority` descending, ties broken by `created_at` then `id` — a total order, so resolution is deterministic even with equal priorities or duplicate rules

#### Scenario: Another tenant's rule is invisible by id

- WHEN principal B requests, patches, or deletes a rule owned by principal A by its id
- THEN the response is 404 and A's rule is unmodified

### Requirement: The rule-resolution and unresolved-target contract for the proxy

This change SHALL document the stored-config semantics the proxy (#10) implements (it does not execute routing here): the highest-`priority` matching rule wins with the total-order tie-break above; a `header` rule matches when the request carries `header_name` with an exact, case-sensitive `header_value`; a `default` rule (if present) supplies the fallthrough target, otherwise the seeded `default` tier is used. Because `target` is an opaque string with no foreign key, a target validated at write time MAY later become **unresolved** when its referenced tier or model is deleted; the proxy SHALL treat an unresolved target — like a resolved-but-empty tier — as a clear, stable client-facing routing error rather than a silent failure or 500. A `tier:<key>` target is **late-bound by key**: recreating a deleted tier's key rebinds the rule to the replacement tier (targets carry no tier identity beyond the key — this is intended, not a dangling reference).

#### Scenario: Deletion unresolves a target; key recreation rebinds it

- WHEN a rule's target tier or model is later deleted
- THEN the config layer does not retroactively delete or rewrite the rule (there is no FK), and the now-unresolved target is surfaced by #10 at request time as its documented routing error
- WHEN a `tier:<key>` target's tier was deleted and a new tier is later created with the same key
- THEN the rule resolves to the new tier (late binding by key), with no rewrite of the stored rule

### Requirement: One shared target parser is the single source of truth

The system SHALL provide pure, dependency-free `parseRoutingTarget` / `formatRoutingTarget` helpers and routing constants (`DEFAULT_TIER_KEY`, `TIER_HEADER_NAME` = `x-polyrouter-tier`, `AUTO_ALIAS` = `auto`, `MAX_MODELS_PER_TIER` = 5, the tier-key pattern) in `@polyrouter/shared/server`, so the management API (this change) and the proxy (#10) parse and format targets identically.

#### Scenario: Targets round-trip and reject malformed input

- WHEN a valid target string (`tier:<key>` or `model:<id>`) is parsed
- THEN it yields a typed discriminated value (`{ kind: 'tier'; key }` or `{ kind: 'model'; id }`) that formats back to the identical string
- WHEN a malformed target (no known prefix, empty reference) is parsed
- THEN the helper returns null (no throw), so callers surface a clean validation error

### Requirement: Empty tiers are a valid config state; the runtime error is the proxy's

The configuration layer SHALL allow a rule or route to target a tier that currently has no routing entries (an empty tier is a valid intermediate state) and SHALL expose emptiness as a well-defined `[]`. The exact request-time error (status/code/body) for resolving to an empty tier is defined and owned by the proxy (#10); this change only guarantees emptiness is observable and never silently accepted as a routable state.

#### Scenario: Targeting a currently-empty tier is allowed at config time

- WHEN a principal creates a rule targeting an owned tier that has no entries yet
- THEN the rule is accepted (models can be assigned later)

#### Scenario: Emptiness is observable for the proxy to enforce

- WHEN the entries of a tier are listed and the tier has no models
- THEN the result is an empty list (a well-defined state), which #10 maps to its documented "tier has no models" error at request time

