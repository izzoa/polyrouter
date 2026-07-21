# @polyrouter/control-plane

## 0.6.0

### Minor Changes

- 7dc88d2: Long-running research-class models now work end-to-end
  (fix-long-call-timeouts). **Per-provider patience overrides** — set
  first-response and between-chunks timeouts (1s–1h) on a single provider from
  the provider form's Advanced section (blank = inherit the instance defaults,
  shown honestly from the server) — resolved per chain attempt, so a raised
  research provider never slackens hang detection elsewhere. **The hidden 300s
  undici ceiling is gone**: the SSRF-guarded dispatcher's header/body timeouts
  are now derived above polyrouter's own typed bounds, so raising a knob actually
  holds and timeouts stay typed and correctly breaker-classified. **Keepalives
  count as liveness**: upstream bytes (OpenRouter's `: OPENROUTER PROCESSING`
  comments included) re-arm the streaming stall watchdog and renew the breaker's
  half-open probe lease, so a streamed deep-research call with long silent
  thinking gaps is no longer aborted as stalled — true silence still trips at
  exactly the configured bound. Operator guidance: raise the slow provider's
  patience, prefer streaming, and size your client SDK's own timeout — the one
  bound the router cannot lift.

### Patch Changes

- Updated dependencies [7dc88d2]
  - @polyrouter/shared@0.6.0
  - @polyrouter/data-plane@0.5.0

## 0.5.0

### Minor Changes

- fdb6930: Opt-in prompt/response body capture (add-body-capture) — the invariant-8 door,
  **off by default**. A selfhosted owner can enable a three-way mode (off /
  errors-&-escalations-only / all) behind an explicit consent confirm, refine it
  per agent (inherit/always/never — inert while the global mode is off: the
  master switch is the consent boundary), and see the state honestly (green
  `Metadata-only` ↔ amber `Bodies captured`). Captured bodies are client-wire
  (media-stripped, 256 KiB/direction cap with honest truncation), stored
  **encrypted** in a separate `request_body` table off the hot path (byte-budgeted
  writer queue; a dropped body never touches the request), retained 30 days by
  default (infinite only as an explicit "keep forever" choice) with a daily purge
  job, per-request delete + purge-all + keep-or-purge on disable — all race-proof
  against in-flight writes (owner-locked inserts, epochs, tombstones). The
  inspector gains a lazily-fetched Payload section; the request listing exposes
  only a `hasBodies` flag. Cloud instances never capture.
- 0dea2a0: Pricing stays current by itself (add-pricing-refresh-ui): a **daily automatic
  LiteLLM catalog refresh — on by default** (self-host only; one env line opts
  out: `PRICING_REFRESH_SCHED_ENABLED=false`) on its own BullMQ queue riding the
  existing guarded refresh path, plus a Settings **Pricing catalog** panel for
  admins — entry count, newest version, a literal "never refreshed" callout, the
  schedule state, and a Refresh-now button. Refresh completions land in a new
  append-only run ledger (recorded atomically with the version apply; a `+0`
  unchanged pull counts as fresh; garbage bodies fail instead of advancing
  freshness), `GET /api/pricing/status` exposes it, and cloud instances neither
  schedule nor allow catalog mutations (enforced at the service boundary; boot
  seeding exempt). New prices apply to new requests only — recorded costs never
  change.

### Patch Changes

- 0c3fa53: The request inspector shows which header chose the route
  (add-routing-header-visibility): a header-routed request (`decision_layer =
header`) now records the matched header structurally — the built-in
  `x-polyrouter-tier` header records its name plus the matched owned tier key;
  a custom header rule records its header **name only** (a configured rule value
  can itself be a credential and is never persisted — fail-closed) — in two new
  nullable `request_log` columns, exposed on the analytics request listing and
  rendered as a dedicated `header` row in the inspector's DECISION section.
  Non-header decisions and rows predating the columns render exactly as before.
- Updated dependencies [fdb6930]
- Updated dependencies [0dea2a0]
- Updated dependencies [0c3fa53]
- Updated dependencies [a7e41c5]
  - @polyrouter/data-plane@0.4.0
  - @polyrouter/shared@0.5.0

## 0.4.0

### Minor Changes

- 91e4ea5: Auto-routing decisions become queryable. Every `auto` request the structural
  layer evaluates now records its verdict as request_log columns —
  `structural_band` (high/low/ambiguous), `structural_score`, and
  `structural_band_source` (threshold vs a declared-maximal rule) — on every
  row the request produces, including cascade rows (the L1 verdict beside the
  L3 outcome) and the previously-invisible fall-throughs: an ambiguous
  classification that stayed on the default tier, and a confident band whose
  auto_high/auto_low target wasn't configured. Fall-through rows' routing
  reason now carries the classifier verdict as a visible suffix, so the
  inspector shows WHY auto stayed on default. Requests the layer didn't
  evaluate record nulls; history is never backfilled; no routing behavior
  changes.
- 2fdc5d0: `model: auto` now honors client-declared complexity. OpenAI `reasoning_effort`
  (including `xhigh`/`max`), Anthropic `thinking` (enabled budgets, `adaptive`,
  `disabled`), and Anthropic `output_config.effort` become a Layer-1 signal: a
  maximal declaration routes a request to the `auto_high` target directly, low
  declarations bias the structural score downward (a declared `none` on an
  otherwise-ambiguous request takes the cheap path without cascade), and
  `response_format`/`output_config.format` count as structured-output demand.
  Requests without declared controls score byte-identically to before — ambient
  weights, thresholds, and existing `ROUTING_STRUCTURAL_WEIGHTS` overrides are
  untouched; the new optional `reasoning` key in that JSON tunes the adjustment
  magnitude ([0, 0.5], default 0.1). Anthropic `output_config` also now passes
  through same-protocol requests verbatim (dropped, documented, crossing to
  OpenAI).
- f7b3d0d: Failed requests now record and display what the provider actually said. The
  request drawer gains an ERROR card (error kind, upstream HTTP status, the
  provider's own error message, and the upstream request id) backed by four new
  `request_log` columns captured at failure time — including mid-stream failures,
  whose wire error message was previously discarded. Privacy holds by
  construction: messages persist only from structured provider error fields
  through a sanitizing factory (exact credential redaction first, then heuristic
  secret scrubbing; validation and content-policy messages are withheld since
  they can quote prompt content), raw bodies never persist, and agent-facing
  error responses are unchanged. Existing rows render exactly as before.
- 7361e93: Add the "Auto performance" view (add-auto-performance-view): a new owner-scoped
  `GET /api/analytics/auto` aggregation (band mix with declared/unroutable splits,
  the disjoint four-way cascade outcome split, fall-through count, per-bucket band
  series, range-independent telemetry-since, and a signed estimated-savings figure
  priced at the current `auto_high` basis with per-row exclusion disclosure), plus
  a Routing-page section rendering it: outcome rates, an unroutable diagnostic
  callout, net savings with basis label + coverage ("based on N of M
  quality-passed requests"), a dash-differentiated band-mix chart, a local range
  control, and honest zero states. Stored request costs are never recomputed —
  savings are a live, labeled counterfactual.
- fd63d4a: Per-tenant structural-threshold self-calibration (add-auto-threshold-calibration):
  an opt-in, scheduled BullMQ sweep nudges each tenant's `auto` high/low
  thresholds from their OWN quality-decided cascade outcomes inside hard rails —
  minimum fresh edge-zone samples (epoch-stamped at decision time), bounded step,
  hysteresis, an anchored max-drift cap (changed instance defaults instantly
  inert and then rebase stale pairs), a minimum band gap enforced on every final
  candidate, and per-edge cooldown. Escalations now record WHY they escalated
  (`escalation_source`: `quality_gate` vs `cheap_error`) so provider faults can
  never read as routing mistakes. Calibrated pairs ride the existing hot-path
  settings read (zero new per-request queries) and degrade to instance defaults
  on any fault. Every move/revert/rebase appends a numbers-only audit event; the
  Routing page gains the Self-calibration section — toggle, effective thresholds,
  one-click revert, and the visible threshold-change history — and the
  auto-layers API reports the instance/calibrated/effective trio. Six new
  `CALIBRATION_*` env keys with fail-fast validation.
- d7cafe1: The cascade's quality gate is sharper. When a request declared structured
  output (`response_format` json, or Anthropic `output_config.format`), a cheap
  answer that isn't parseable JSON now escalates to the strong tier — prose
  where JSON was demanded is a capability failure, not a style choice
  (tool-calling and paused turns are exempt). Truncation (`length` stop) grades
  0.5 instead of a clean 1: at the default quality threshold the served tier is
  unchanged (the recorded quality_signal visibly becomes 0.5), and thresholds
  above 0.5 now meaningfully escalate truncated cheap answers. One deliberate
  escalation change at defaults: demanded JSON cut off by the token cap is
  invalid JSON and escalates, where it previously served broken output.
- 0133f12: feat(pricing): native-family price fallback for aggregator models (flagged estimates)

  Aggregator-routed models (OpenRouter) whose exact channel key is missing from the price
  catalog no longer record `unpriced` when the SAME model's price exists under its native
  family (e.g. `openrouter:minimax/minimax-m3` missing → `minimax:minimax-m3` used): the
  request snapshots the native-family catalog row, **flagged `native_family` end-to-end** —
  a new `price_source` column on both cost ledgers, a `price source` row plus `· est.`
  affordances in the request inspector (the combined total is marked whenever a superseded
  cascade attempt was estimate-priced, via the rolled-up `priceEstimated` flag), an
  estimate-priced spend split (`nativeFamilySpend`) in the analytics summary and Costs page,
  and estimate marking in budget alert/block notices and the weekly spend summary. Budgets
  meter estimate-priced spend identically — recorded cost is recorded cost.

  The derivation is allowlist-only (aggregator families + a verified vendor→family map;
  unmapped vendors stay unknown; `:free` SKUs never borrow the paid rate), the exact channel
  key always wins once it exists (new requests only — recorded rows are immutable), and
  provider-listed `/models` prices still never enter billing: the models UI now shows the
  listed channel figure **alongside** a native-family estimate (new `listedPrice` on the
  models API) instead of hiding it. Migration `0011` adds the nullable `price_source`
  columns; existing rows render exactly as before.

### Patch Changes

- Updated dependencies [91e4ea5]
- Updated dependencies [2fdc5d0]
- Updated dependencies [f7b3d0d]
- Updated dependencies [7361e93]
- Updated dependencies [fd63d4a]
- Updated dependencies [d7cafe1]
- Updated dependencies [0133f12]
- Updated dependencies [98f3b59]
  - @polyrouter/shared@0.4.0
  - @polyrouter/data-plane@0.3.0

## 0.3.0

### Minor Changes

- eceaa5a: feat(subscription): ChatGPT Plus/Pro preset + the `openai_responses` upstream protocol

  The subscription-OAuth wizard gains a **ChatGPT Plus / Pro** preset (alongside Claude
  Pro/Max): sign in at auth.openai.com, land on the dead `localhost:1455` tab, and paste the
  redirect URL back — polyrouter exchanges the code (PKCE, form-encoded per this endpoint),
  extracts the ChatGPT account id from the exchange's `id_token` (nested
  `https://api.openai.com/auth` claim, strictly validated, sealed inside the encrypted
  envelope, never logged or echoed), and creates a provider that speaks the ChatGPT backend's
  **Responses API** — a new upstream-only `openai_responses` protocol translation
  (`requestOut`/`responseIn`/stream parsing behind the same Normalized IR, golden-pinned:
  `function_call`/`function_call_output` correlation by `call_id`, parallel-stream assembly
  keyed by `item_id`, refusals surfaced as text, all four terminals, cached-input usage
  subtraction).

  Deliberate limits, stated up front: `store: false` on every call (nothing retained
  server-side by request); reasoning items the backend emits are **dropped, never persisted
  or replayed** (metadata-only trade — can reduce multi-turn tool-use quality); polyrouter
  sends ONLY `Authorization: Bearer` + `chatgpt-account-id` + the Responses beta header —
  **no client-fingerprint headers, no imitation instructions, ever**.

  **Verified live (2026-07-18)** against real accounts — both presets ship **enabled**, and
  the verification pinned real backend quirks into the code: the Codex backend is
  **streaming-only** (buffered chat is stream-and-collect) and **rejects
  `max_output_tokens`/`temperature`/`top_p`** (documented drops — token caps cannot be
  enforced upstream there); the live model list is `gpt-5.4-mini`, `gpt-5.6-sol/terra/luna`,
  `gpt-5.5`, `gpt-5.4`; auth.openai.com rejects a `state` token-body param (now
  preset-declared — Anthropic's exchange wants it) and returns nested error objects (its
  `token_expired` now correctly maps to "reauthorize" instead of looping "try again"); the
  token client pins `Accept-Encoding: identity` (a compressed IdP response must never be
  undecodable). Full flows proven: connect + account-id claim, buffered + streamed proxied
  completions, live tool calling, and forced token refreshes on both presets (Claude's
  proxied completion returned the account's own usage-window 429, surfaced as a typed
  `rate_limit_error` — correct behavior; see `scripts/verify-*-oauth.md` for the records).

  Supporting changes: the token client is preset-encoding-aware (`json`/`form`), surfaces
  `id_token` from the exchange only, and a refresh response that omits `refresh_token` now
  **retains the stored one** (non-rotating endpoints — applies to Claude too); the
  `openai_responses` protocol is connect-only (the public create/update API rejects it) and
  `listModels` on a models-endpoint-less provider is a typed error while `test-connection`
  runs a designated 1-token probe; editing any OAuth-connected provider now submits a
  **name-only** patch with endpoint/kind/protocol shown read-only (previously the edit form
  echoed them, which would 400 on a Responses row).

- eceaa5a: feat(providers): show real prices for aggregators (display estimate) + edit providers

  Aggregator providers (OpenRouter and other OpenAI-compatible model lists that carry
  per-model pricing) no longer show a blank "catalog price". Their `/models` prices are now
  captured at **sync** as a per-provider **display estimate** (new `listed_*` model columns)
  and surfaced in the Providers and Routing UIs with clear provenance — "provider-listed ·
  estimate", "catalog", "you set this", or an honest "unpriced — cost not tracked".

  The estimate is **display only**: it never enters the `model_prices` catalog, `resolveModelPrice`,
  or the request-time cost snapshot, so recorded cost stays honest (invariant 4 — cost comes
  from the bundled catalog, not provider `/models`; an aggregator request still records
  `unknown` cost rather than a possibly-wrong `/models`-derived one). Authoritative aggregator
  cost (via upstream usage accounting) remains a future enhancement.

  `GET /api/models` (and the model-pricing `PATCH` response) now return a resolved
  `effectivePrice { input, output, isFree, source, estimated }`, resolved via a single bounded
  catalog lookup; the `isFree` filter applies to the effective price.

  Providers can now be **edited** from the dashboard — an Edit action opens a form for name,
  kind, protocol, base_url, and credential (`PATCH /api/providers/:id`). The credential follows
  the write-only contract: blank preserves the stored key, an explicit "remove stored credential"
  control clears it, a typed value rotates it. Changing base_url/protocol clears stale listed
  estimates; a kind change to api_key/subscription warns that user-set model prices are cleared.

- eceaa5a: feat(providers): real subscription OAuth — connect wizard, token lifecycle, Claude preset

  The `subscription` provider kind is now a real capability instead of a label:

  - **Connect wizard** (Manifest-style paste-back): pick a preset, sign in at the provider's
    authorize link, paste the redirect URL or `code#state` string back — polyrouter verifies
    `state` (required on every paste form), exchanges the code (PKCE S256) at the preset's fixed
    token endpoint, and creates the provider with a pinned base URL/protocol. Sessions are
    server-held (Redis, ~10 min TTL), single-use (atomically consumed before the exchange),
    bound to your login session, and rate-limited per user and per IP.
  - **Token lifecycle**: access + refresh tokens live in a typed encrypted envelope (plain pasted
    credentials are now wrapped in the same envelope — legacy stored credentials keep working).
    Tokens auto-refresh before expiry with cross-instance single-flight (advisory lock + in-lock
    re-read; refresh-token rotation can't be clobbered), transient IdP outages back off and keep
    serving the still-valid token, and a revoked grant becomes a durable **"reauthorize
    required"** state with a one-click reconnect on the provider card. Credential failures are
    breaker-neutral; only a successful reauthorization resets the provider's breaker.
  - **Anthropic OAuth wire support**: subscription providers with OAuth credentials authenticate
    with `Authorization: Bearer` + the required `anthropic-beta` value (not `x-api-key`).
  - **Claude Pro/Max preset** ships **disabled** pending live verification against a real
    account (`scripts/verify-claude-oauth.md`): the preset's endpoints are ecosystem-known, not
    a documented contract — polyrouter never ships an enabled-but-unverified preset, sends only
    the documented headers, and never imitates the first-party client beyond them. The ToS
    caution for flat-rate subscription reuse still applies and is shown in the UI.

  Migration 0010 adds non-secret provider columns (`oauth_preset`, `credential_expires_at`,
  `credential_error`). Rotating `PROVIDER_CREDENTIAL_KEY` invalidates stored envelopes; OAuth
  providers then require reauthorization.

### Patch Changes

- Updated dependencies [eceaa5a]
- Updated dependencies [eceaa5a]
- Updated dependencies [eceaa5a]
- Updated dependencies [eceaa5a]
  - @polyrouter/data-plane@0.2.0
  - @polyrouter/shared@0.3.0

## 0.2.0

### Minor Changes

- 14fe461: Add **Hermes Agent** (Nous Research) as a supported harness, alongside OpenClaw. It now appears in the dashboard's **Agents → New** harness picker and gets a correct copy-paste connection snippet on create/rotate — a `~/.hermes/config.yaml` `model:` block (`provider: custom`, the router's OpenAI-compatible `/v1` base URL, the minted `poly_…` key, `default: auto` so polyrouter routes). The snippet's `base_url`/`api_key` are emitted as escaped scalars so an unusual endpoint URL can't corrupt the YAML. The harness field is presentational metadata only (label + snippet) — no routing/cost/proxy behavior changes and no migration (`harness_type` is a free-form text column). A new golden-snippet test in `@polyrouter/shared` pins every harness's output. The README "Connect an agent" section gains a terminal-coding-agents subsection documenting both OpenClaw and Hermes, including Hermes' `~/.hermes/.env` env-substitution alternative for keeping the key out of the YAML.
- ed0d35c: Add **user administration**: first-signup-wins bootstrap, invite-only registration, and admin user management.

  The first account to sign up on a fresh instance wins an atomic bootstrap claim, becomes the admin, and registration **closes to `invite_only`** — subsequent public sign-ups are refused (403) until an admin reopens them. Admins get a new **Users** page (sidebar, admin-only): list users, promote/demote admins, disable/enable, delete, issue and revoke invites, and switch the registration mode between `invite_only` and `open`. A **last-enabled-admin guard** (advisory-locked) refuses any delete/demote/disable that would leave the instance without an enabled admin (409).

  **Invites** are single-use, expire after 72 hours, and are pinned to the invited email. Only a SHA-256 hash + 12-char prefix is stored — the raw token rides once in the returned link's **URL fragment** (`/accept-invite#token=…`, never in the query string, so it can't leak into access logs or Referer headers). If server SMTP (`SMTP_*` env) is configured the invite is emailed automatically; otherwise the dashboard shows the copyable link — issuing always works without SMTP. The public `/accept-invite` page collects name + password and lands the new user signed in; `/api/invites/accept` is rate-limited per-IP and answers every bad/expired/replayed token with the same uniform error.

  **Disabling a user cuts both credential planes at once**: their dashboard sessions are revoked in the same transaction (and again on re-enable, so no raced session can resurface), new sign-ins are refused, and every agent API key they own stops authenticating on `/v1` immediately.

  The signed-in identity now lives in a **account menu** at the bottom of the sidebar (avatar + email): Settings, theme toggle, Users (admins), and Log out — replacing the standalone theme button and the Settings-page Log out.

  **Upgrade note (deliberate behavior change):** migration 0008 seeds existing instances to `invite_only` — on upgrade, public sign-up closes until an admin reopens it under **Users → Registration**. Existing accounts are untouched. Break-glass (locked out with no enabled admin): re-enable directly in Postgres — `UPDATE "user" SET disabled = false WHERE email = '<you>';` (and `role = 'admin'` if needed) — then sign in again.

### Patch Changes

- Updated dependencies [14fe461]
- Updated dependencies [ed0d35c]
  - @polyrouter/shared@0.2.0
