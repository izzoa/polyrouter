## MODIFIED Requirements

### Requirement: Routing-rule CRUD with a structured, write-time-validated target

The system SHALL expose CRUD for routing rules under `/api/routing/rules`, tenant-scoped, with fields `match_type` (`header`|`default`), `header_name` (default `x-polyrouter-tier`), `header_value`, `target`, and `priority` (default 0) (spec §5, §7.2). The `target` is a structured reference — `tier:<key>` or `model:<id>`. Target references are validated **at write time** against the caller's own tiers and models (best-effort referential integrity — see the unresolved-target contract below). `header_name` is normalized to a valid lower-cased HTTP field-name; on create, `header_name` and `priority` are optional and fall back to their defaults. An explicit JSON `null` for a **non-nullable** field (`match_type`, `header_name`, `target`, `priority`) SHALL be rejected with a 4xx validation error and leave any stored rule unchanged — it SHALL NOT be treated like an absent field (which would reach a parser/NOT-NULL column and 500, or silently rewrite the rule to a default). (`header_value` remains optional at the DTO layer, but the effective-merged validation still requires a `header` rule to carry a value, so an absent/`null` `header_value` on a `header` rule is itself a 4xx.)

#### Scenario: A header rule maps a header value to an owned target

- WHEN a principal creates a `header` rule with `header_value` set and `target` = `tier:<an existing owned tier key>` (or `model:<an existing owned model id>`)
- THEN the rule is created and returned, with `header_name` defaulting to `x-polyrouter-tier` (lower-cased) when omitted
- WHEN the target references a tier key or model id the principal does not own (or is malformed)
- THEN the request is rejected with a clear 4xx error and no rule is created

#### Scenario: match_type and header fields are validated, including the effective row after PATCH

- WHEN a principal creates a rule with a `match_type` outside {`header`,`default`}, a `header` rule missing `header_value`, or an invalid `header_name`
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
