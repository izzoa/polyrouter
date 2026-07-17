## MODIFIED Requirements

### Requirement: Deleting a provider cascades to its models and routing entries

Deleting a provider SHALL remove its `Model` rows and any `routing_entries` that referenced those models (the schema's `ON DELETE CASCADE`), because a deleted provider's models are no longer routable. This destructive cascade SHALL be explicit and covered by a test rather than an accidental side effect. Deleting a provider or model SHALL, in the same transaction, **re-compact** every affected tier's surviving `routing_entries` to contiguous positions starting at 0, so the config-layer invariant (position 0 is the primary, positions are gapless) survives the cascade — a tier that still has healthy models after its position-0 model's provider is deleted MUST remain routable (its next surviving model becomes the primary), not report `empty_tier`. A tier left with no surviving models is genuinely empty (and reports `empty_tier` at proxy time, per routing-config).

#### Scenario: Delete removes the provider's models and their routing entries

- **WHEN** a provider with synced models (some assigned to a tier) is deleted by its owner
- **THEN** the provider, its `Model` rows, and the `routing_entries` referencing those models are all removed
- **AND** a cross-tenant delete of another tenant's provider fails closed (`404`) and removes nothing

#### Scenario: Deleting a tier's position-0 provider leaves the tier routable

- **WHEN** a tier has a cross-provider chain (model A at position 0, model B at position 1) and the provider owning model A is deleted
- **THEN** the cascade removes A's entry and re-compacts the tier so model B is at position 0, and a subsequent request routed to that tier serves from B (not `empty_tier`)
- **AND** deleting the provider of the tier's only model leaves the tier genuinely empty
