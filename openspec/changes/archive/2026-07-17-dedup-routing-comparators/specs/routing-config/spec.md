## MODIFIED Requirements

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
