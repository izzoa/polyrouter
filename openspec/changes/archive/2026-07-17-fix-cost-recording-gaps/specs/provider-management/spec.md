## MODIFIED Requirements

### Requirement: Update validates the effective merged config and preserves the credential

An `update` SHALL validate the *resulting* provider, not the patch alone: the service SHALL fetch the owned row, compute `nextKind`/`nextBaseUrl` from the patch merged over the stored values, and SSRF-gate that tuple before persisting, so a partial patch cannot produce an invalid unusable row. The credential SHALL be re-encrypted only when the `credential` field is present in the patch; an omitted credential SHALL preserve the existing envelope, and an explicit empty credential SHALL clear it. When the update moves the provider's kind **from** `custom`/`local` **to** `api_key`/`subscription`, the service SHALL clear that provider's models' user-set unit prices (`input_price_per_1m`, `output_price_per_1m`, `is_free`), owner-scoped, so `GET /api/models` does not display a price the resolver will not use. This clear is for display consistency only: correctness is guaranteed centrally by the pricing resolver, which honors a model-own price ONLY for a `custom`/`local` provider (see pricing-catalog), so a stale or concurrently-restored model price on an `api_key`/`subscription` provider can never override the catalog cost regardless of the clear's timing. Historical `request_log` snapshots are unaffected (invariant 4).

#### Scenario: A kind change without a new base_url is validated against the merged tuple

- **WHEN** a `local` provider with a loopback `base_url` is updated to `kind: "custom"` without supplying a new `base_url`
- **THEN** validation runs against `(custom, <stored loopback base_url>)` and rejects it (loopback is not allowed for `custom`)
- **AND** updating only a `local` provider's `base_url` validates against the still-`local` kind

#### Scenario: An omitted credential is preserved; an empty one clears it

- **WHEN** an update omits the `credential` field
- **THEN** the stored `encrypted_credentials` envelope is unchanged (`hasCredential` unchanged)
- **AND** an update with an explicit empty credential clears it (`hasCredential:false`)

#### Scenario: A kind change away from custom/local clears stale model prices

- **WHEN** a `custom` provider with user-priced models is updated to `kind: "api_key"`
- **THEN** those models' `input_price_per_1m`/`output_price_per_1m`/`is_free` are cleared in the same operation, so a subsequent request prices from the catalog (`source` ≠ `model`) and `GET /api/models` shows the prices cleared
- **AND** a change that stays within `custom`/`local` leaves user prices untouched
