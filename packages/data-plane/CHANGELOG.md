# @polyrouter/data-plane

## 0.4.0

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
- a7e41c5: An explicit `x-polyrouter-tier` header now beats every other routing mechanism
  except the `model` field (add-tier-header-precedence). The tier header is one
  coherent resolution phase — its value remaps (dashboard Header rules) first,
  then the direct tier lookup — evaluated before rules on any other header, so an
  API-created rule on e.g. `x-env` can no longer shadow a per-request tier ask at
  any priority. Same-header remap semantics, advisory fall-through, and requests
  without the tier header behave exactly as before.
- Updated dependencies [fdb6930]
- Updated dependencies [0dea2a0]
- Updated dependencies [0c3fa53]
  - @polyrouter/shared@0.5.0

## 0.3.0

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

### Patch Changes

- 98f3b59: fix(pricing): round displayed per-1M prices (no more $0.19999999999999998)

  Provider-listed price estimates are derived from per-token rates ×1e6, which leaves
  float64 noise that rendered verbatim in the Providers and Routing pages. Displayed
  prices now format through a 6-significant-digit formatter ("$0.2", "$2.5", "$0.0375"
  all render cleanly), and the capture path normalizes the stored estimate to 12
  significant digits so future syncs store the clean value the provider actually lists.
  Display/storage cosmetics only — recorded request cost never flowed through either
  path (cost immutability unchanged).

- Updated dependencies [91e4ea5]
- Updated dependencies [f7b3d0d]
- Updated dependencies [7361e93]
- Updated dependencies [fd63d4a]
- Updated dependencies [0133f12]
  - @polyrouter/shared@0.4.0

## 0.2.0

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

- eceaa5a: feat(providers): identify polyrouter to OpenRouter for app attribution

  Requests to an `openrouter.ai`-host provider now carry OpenRouter's app-attribution headers —
  `HTTP-Referer: https://polyrouter.app` and `X-OpenRouter-Title: polyrouter` — so polyrouter
  appears in OpenRouter's public rankings and per-model app analytics. The headers are computed
  once at adapter creation and cover all outbound OpenRouter calls (chat, streaming, model sync,
  test-connection).

  The headers are **non-secret** (an app URL and name — no user data, prompts, or keys) and are
  disclosed **only** to OpenRouter (an exact `openrouter.ai` host match; every other provider —
  OpenAI, Anthropic, custom, local — receives neither header). They are additive and never affect
  authentication. This is default-on with no opt-out.

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
  - @polyrouter/shared@0.3.0
