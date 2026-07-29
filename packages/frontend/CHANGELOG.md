# @polyrouter/frontend

## 0.10.0

### Minor Changes

- 7965e88: Subscription usage is no longer counted as money spent.

  A request served by a Claude Pro/Max provider was priced at Anthropic's **API list rate** and
  recorded as ordinary cost — but that traffic is already paid for by a flat monthly fee, so its
  marginal cost is zero. Three things followed: the Costs page drew it as "paid", every spend
  figure overstated what you owed, and — the one that could actually bite — a `block` budget
  could refuse requests once that notional value crossed its threshold, with nothing in the UI
  saying so. (ChatGPT Plus/Pro traffic is usually unaffected, because `chatgpt.com` is not in the
  pricing catalog's host map and those requests record no cost at all.)

  Each ledger row now snapshots the **kind of provider that served it**, immutably, alongside its
  price snapshot. It is a snapshot rather than a join for the same reason cost is immutable: a
  provider can be deleted, and its kind can be changed, and neither should be able to reach back
  and reclassify what a request was months later.

  The recorded cost itself is unchanged — this changes what is _summed and labelled_, never what
  is _stored_. That matters, because the number is worth keeping: it is exactly what tells you
  whether a subscription is paying for itself.

  **Costs page.** The headline reports what you owe and says it excludes subscription; the
  subscription figure sits beside it as "served on subscription" — visible, so the previous
  combined total is still reconstructable, and simply absent when a range has none. The
  distribution bar gains a fourth segment for prepaid traffic, rendered as a second intensity of
  the existing accent so it still reads as one "paid" block subdivided rather than introducing a
  new colour. Every category now shows its count next to its percentage. The exclusion applies to
  the timeseries and to the model/provider/agent breakdowns too, not only the headline.

  **Budgets choose what they count.** A budget now carries a metering basis. **Existing budgets
  are migrated to `notional` and keep metering exactly what they metered before** — nothing
  changes under you. New budgets default to counting money spent. The reason for the choice
  rather than a blanket fix: metering notional value is a crude proxy for a flat-rate plan's
  finite capacity, but it is currently the only usage throttle polyrouter has, and quietly
  removing it would trade one bug for a subtler one. The Limits form makes the choice explicit,
  and budget alerts now state which basis they metered.

  Rows recorded before this release cannot be honestly classified — inferring their billing kind
  from today's providers is the exact rewrite this snapshot exists to prevent — so they keep
  counting toward spend and are reported as their own unclassified component rather than being
  presented as known cash. Expect a visible step in historical figures at the upgrade boundary;
  it ages out of the range naturally.

### Patch Changes

- 131923d: The dashboard no longer slides off the top of the window, and the sidebar's lower content
  stays reachable on a short viewport.

  The app shell is a viewport-height flex row with `<main>` as the intended scroll container,
  but the sidebar owned no overflow of its own. Its content — logo, up to nine nav items, the
  setup-guide card and the account footer, around 520px in total — is taller than a short
  viewport, and the spill enlarged the _shell's_ scroll range. Two problems followed. The
  shell became translatable: `overflow:hidden` suppresses a scrollbar but still makes a box a
  scroll container, so focus moving to a clipped control, `scrollIntoView`, or scroll
  anchoring could shift it — and when the shell shifts, every pane shifts together, carrying
  the topbar and the page content off-screen. And the sidebar's lower items, the account menu
  among them, were simply clipped out of reach with no way to scroll to them.

  The sidebar now scrolls internally, which fixes the reachability and removes the shell's
  scroll range at its source. The shell is additionally `overflow: clip`, which creates no
  scroll container at all, so it cannot be moved by any mechanism even if some future pane
  reintroduces a spill. Scrolling inside the sidebar and `<main>` is unaffected — they are
  their own scroll containers.

  Reaching the end of either pane no longer chains the remaining scroll outward. That
  containment is deliberately limited to the vertical axis so horizontal swipe-back and
  forward navigation gestures keep working.

  The shell is also sized in `dvh` now, falling back to `vh` on older engines. The static `vh`
  unit resolves against the viewport with mobile browser chrome retracted, so a `100vh` shell
  is taller than what is actually visible — the same "page extends past the window" symptom,
  reached a different way.

- Updated dependencies [7965e88]
  - @polyrouter/shared@0.10.0

## 0.9.3

### Patch Changes

- 6785600: Dragging models to reorder a tier's fallback chain now lands where you dropped them, and the
  chain can be reordered from the keyboard.

  Two independent defects made the Routing page's drag-to-reorder flicker and fail to stick.
  The chain **is** the fallback policy — position 0 is the primary every `auto`/tier-routed
  request hits first — so a reorder that silently reverted or landed in the wrong order left
  the operator believing they had configured one routing policy while the proxy ran another.

  The first defect: in-progress drag state was keyed by list index, and the index was re-read
  _after_ the reorder had already been applied — at which point it referred to the drop target's
  new position, not the dragged row's. The marker latched onto the wrong row, subsequent drag
  events moved the wrong entry, and for an adjacent swap it became a stable oscillator that
  flipped the order back and forth at the browser's drag-event rate with the pointer held
  perfectly still. Which order survived depended on where that oscillation happened to be when
  the drop landed. Drag state is now keyed by model identity, so there is no index to go stale.

  The second: a chain write's response, or a routing refresh, could arrive mid-drag and repaint
  the whole chain from server state, discarding the in-progress reorder. Reachable by dragging
  within a round-trip of any other chain edit, or simply by leaving the Routing page and coming
  back while a refresh was still in flight. An in-progress drag now defers that server state
  until the drag ends — the user's order wins if they moved something, and the deferred state is
  applied if they didn't, so a no-op drag still converges without issuing a write.

  Also in this change: a reorder now commits only once the pointer crosses the target row's
  midpoint, so jitter on a row boundary no longer re-triggers it; the drop is properly accepted
  instead of resolving as a cancelled drag (which made the browser animate the row snapping back
  to where it started); drag data is set on `dragstart`, which Firefox requires to begin a drag
  at all; and the row hover highlight no longer chases rows as they move.

  **New:** the `⋮⋮` handle is now a real button. Focus it and press `Alt`+`Arrow Up` / `Alt`+`Arrow
Down` to move an entry, with focus following the row and the new position announced to screen
  readers. Previously `Make primary` was the only keyboard path, which could only reach position
  0 — there was no way to order one fallback against another without a mouse.

## 0.9.2

### Patch Changes

- d261c36: Release images are now built on native runners per architecture instead of emulating
  arm64, so a release publishes reliably. The `linux/arm64` half of every image used to be
  cross-built under QEMU, which is a nondeterministic-failure generator: it broke two of the
  last three releases by crashing with `qemu: uncaught target signal 4 (Illegal instruction)`
  inside `npm ci` and then **wedging** — the build never failed, it emitted progress
  heartbeats for 88 more minutes until the job timeout killed it. v0.9.1 shipped half a
  release because of it: the `-semantic` variant published while the baseline did not, leaving
  `latest` pointing at 0.9.0 for two hours.

  Each architecture now builds on its own native runner, pushes an untagged digest, and a
  merge job assembles the manifest list — so tagging happens once, at the end, and no
  architecture can clobber another's `latest`. The published contract is unchanged: same
  tags, same two platforms (`linux/amd64` + `linux/arm64`), same plain manifest list with no
  attestation entries. The `-semantic` variant's ORT smoke test is strictly stronger now,
  because it exercises the real arm64 kernel dispatch on real hardware rather than validating
  QEMU's softfloat.

  Measured on the first native run, all caches cold: the arm64 leg that used to wedge for 88
  minutes finished in 1m45s, and the entire release — both variants — took 3m40s against
  20m42s on the best previous run.

  Also fixed: every image's `org.opencontainers.image.licenses` **annotation** reported the
  deprecated `AGPL-3.0` while its **label** correctly said `AGPL-3.0-only`. A custom label
  does not propagate to annotations in `docker/metadata-action`; both lists now carry the
  same value.

## 0.9.1

### Patch Changes

- cb8deec: Green status text now meets the WCAG AA contrast floor in light mode. The fill green
  used for dots, bars and chip backgrounds is only 2.7:1 on white — fine for a 6px dot,
  a failure for the small "OK · served" / "Live" / "free" / "accepted" / "enabled" labels
  that also used it. Those labels move to a new darkened `--green-text` token (5.4:1 on
  panel, 4.8:1 on the green chip background), while every dot, bar and fill keeps the
  original green, so nothing changes visually except that the small green text is now
  legible. Dark mode already passed at 8.1:1 and is unchanged.

## 0.9.0

### Minor Changes

- 5f01470: The dashboard now receives live updates over a **push stream** instead of only asking.
  One multiplexed, session-guarded, owner-scoped SSE endpoint (`GET /api/events`) carries
  in-flight presence as data and analytics staleness as a thin nudge, so an in-flight
  request appears the moment it starts and its handoff to the completed row happens on an
  explicit `settled` event rather than being inferred from a row's absence in a later poll.

  Polling remains the reliable core: if the stream can't be established, is refused, drops,
  is buffered by a proxy, or the browser has no `EventSource`, the dashboard falls back to
  its normal refresh and keeps working — and says **Polling** rather than **Live**, so a
  buffered deployment is visible instead of silently frozen.

  Push can never cost more than the polling it supplements: nudges are coalesced server-side
  and share one refresh budget with the analytics poll (a nudge consumes the next scheduled
  poll rather than adding to it), so a burst of thousands of settled requests cannot turn
  into a query storm, while an idle instance adds no queries at all.

  Operationally: dashboard streams are closed immediately at shutdown and never wait on the
  inference drain (restarts stay fast), new streams are refused while draining, per-connection
  queues are bounded and collapse to a resync rather than buffering for a slow client,
  concurrent streams are capped per owner, and authorization is revalidated for the life of
  each stream so disabling a user cuts this plane too. New env: `EVENTS_ENABLED`,
  `EVENTS_HEARTBEAT_MS` (plus reconciliation/cap/queue/coalesce knobs, all defaulted).
  Reverse proxies must not buffer `/api/events` — see the README operations note.

- 4282ffd: The dashboard now shows requests that are **running right now**. Until now the
  Overview's "Recent requests" card was completed-only — a request stayed invisible
  for its entire life (often 7–12s on reasoning models) because the `request_log`
  row is written once, at the terminal outcome. An ephemeral, owner-scoped, metadata-
  only in-flight registry in Redis now records live presence: the proxy publishes an
  entry once the route resolves (naming the model actually executing — the cheap tier
  for a cascade) and clears it when the request settles. Live rows render above the
  completed rows with a pulsing "Running" status and a latency that ticks client-side,
  with `—` for tokens/cost (those values do not exist until settle).

  The registry never touches the request path: every write is fire-and-forget, and a
  Redis fault — down _or_ hung — degrades to exactly the old behavior (no live view)
  without inference ever awaiting it. The RequestLog contract is unchanged: nothing is
  written to `request_log`, cost stays immutable, and `running` is not a stored status.
  The served row's id is now allocated at admission so the live entry and the durable
  row share one id, letting the dashboard hand off between them without ever showing a
  request twice. `GET /api/analytics/inflight` returns the owner's live snapshot with
  `available`/`truncated` completeness flags, so a degraded or capped poll is never
  mistaken for "this request finished".

### Patch Changes

- d7f58b3: Each primary nav page now has an identifying line-icon in the left-rail nav, carried
  into the page header when selected. A single `Record<Page, …>` registry
  (`components/PageIcon.tsx`) is the sole source of the glyph, consumed by both the Sidebar
  and the Topbar so the two can never drift. Icons are decorative inline SVG (lucide
  geometry, `currentColor`) — no icon-library dependency and nothing fetched at runtime; in
  the rail they ride the nav button's `text2 → accent-deep` color (no new hue, single-accent
  lock preserved) and in the header they sit at a quiet `--text3`. `setup` keeps its rail
  progress ring (which encodes progress, not identity) and shows its icon in the header only.
- 9498dab: The dashboard no longer polls while its tab is hidden, and refreshes immediately when
  you come back. Every recurring poller (Overview analytics + live in-flight rows, Costs
  analytics) is now gated on document visibility as well as page scope, so a backgrounded
  tab costs nothing instead of ~40 requests/min forever; on return each poller performs
  exactly one catch-up fetch, so the view is never stale. The live in-flight poll also
  relaxes from 2.5 s to 5 s while there is provably nothing in flight and snaps straight
  back on the first live row, leaving the settle handoff at full speed. Measured on an
  idle, visible Overview: 28 requests/min, down from 40; hidden: zero.

  Two correctness fixes fall out of the same rewiring. Pollers are now **single-flight** —
  a pending fetch is never overlapped (a resume or elapsed interval defers to exactly one
  trailing catch-up), because the in-flight loader applies every response unconditionally
  and out-of-order snapshots could otherwise falsely settle a live row. And live-view state
  is now **identity-scoped**: the in-flight loader discards a response captured under a
  previous account, and an account change — including a mid-session session expiry —
  clears cached live rows and invalidates the in-flight durable refresh, so one account's
  rows can never appear under another's.

- Updated dependencies [4282ffd]
  - @polyrouter/shared@0.9.0

## 0.8.1

### Patch Changes

- 8156158: The request inspector header now shows the date alongside the time (e.g. `2026-07-22
10:01:58`) instead of time alone, so a request's timestamp is unambiguous across days.
  New `fmtDate`/`fmtDateTime` helpers render an ISO `YYYY-MM-DD` date to match the header's
  technical mono treatment; scoped to the inspector (the request table stays compact
  time-only). No behavior change beyond the display.
- 4d9cbd5: Record a provider-listed price fallback for models the catalog doesn't cover
  (record-listed-price-fallback). The cost resolver `resolveModelPrice` gains a final
  `listed` tier — below the bundled/LiteLLM catalog and the native-family estimate, above
  `unpriced` — so a model whose catalog paths all miss but whose provider (e.g. OpenRouter)
  reported a per-token price at `sync-models` time now records that captured listed price
  with `source: 'listed'` instead of `unpriced`. LiteLLM always wins: listed is consulted
  only when the catalog (exact + native-family) is unknown, and never overrides it. The
  listed price is snapshotted onto the RequestLog at request time (immutable, like every
  source) and marked as an estimate everywhere — `priceEstimated: true`, the inspector's
  `provider-listed · estimate` label and `· est.` marker, the request-table `~`, budget-alert
  provenance, and the weekly-summary estimate caveat — never presented as an authoritative
  cost. A 0/0 listed price that is not asserted free (token rates zero but a per-request/image
  charge) records `unpriced` rather than a misleading "free", since the non-token cost can't
  be captured. The display and recorded-cost paths now share one resolver (the Models-page
  effective price and the RequestLog resolve identically). This deliberately
  relaxes invariant 4 (recorded cost may now come from a provider estimate) under three
  guardrails: the catalog always wins, the estimate is clearly marked, and it is snapshotted
  immutably. No schema/migration change — the value flows through the existing
  `routing`/`listed_*` columns and `price_source`.
- Updated dependencies [4d9cbd5]
  - @polyrouter/shared@0.8.0

## 0.8.0

### Minor Changes

- bb6bee8: Layer-2 semantic dashboard + batteries-included image variant (add-semantic-dashboard).
  The permanently-locked "L2 · Semantic" stub becomes a real driven toggle in the Routing
  page's layer list — `semantic`/`semanticAvailable` from the auto-layers API, honored per
  tenant live, with honest copy: available → "Embedding classifier over the ambiguous
  slice"; unavailable → an "off instance-wide" affordance naming `SEMANTIC_MODEL_PATH`. No
  inert control and no "cloud tier" contradiction remain. When the semantic layer is
  effective a **learning card** (calibration-card pattern) renders: the opt-in learning
  toggle, a status line (fresh per-label sample counts, last-applied time, active
  `learned`/`bundled` source), the numeric audit history, and a confirmed one-click
  **Revert to bundled** — honest under degradation, a stale/version-mismatched learned
  centroid shows `source: bundled` WITH the reason, never a silent wrong "learned" badge.
  Auto-performance gains the semantic slice from an extended analytics aggregation:
  evaluated count, routed-per-band counts, their four-way outcome split (success / fallback
  / error / cancelled, disjoint + exhaustive over the routed total), and the bundled/learned
  source split over evaluated rows — with a residual-cascade denominator footnote and every
  cascade-derived figure (savings, pass rates) labeled residual-only so pre-/post-enable
  comparisons stay honest. No figure claims learning EFFECTIVENESS (no counterfactual
  exists). The request inspector carries a `semantic_source` provenance chip. Legacy rows
  with no semantic telemetry render the section's existing empty affordance — never
  fabricated zeros. Packaging: a multi-arch **`-semantic` image variant** built from the
  same Dockerfile (`--target runtime-semantic`, glibc base, exact-pinned `onnxruntime-node`
  with the CUDA postinstall disabled, the reference `all-MiniLM-L6-v2` model — Apache-2.0 —
  downloaded checksum-pinned at BUILD time and baked in, `SEMANTIC_MODEL_PATH` preset), a
  `docker-compose.semantic.yml` override with bring-your-own-model support, and a release
  smoke test that loads the baked model + runs one warmup inference on BOTH arches before
  publish. The baseline image stays ORT- and model-free (the CI neutrality assertion is the
  permanent gate).

### Patch Changes

- 6c11c59: Per-provider outbound max-tokens spelling (add-max-tokens-spelling). OpenAI-compatible
  providers gain a `maxTokensSpelling` setting (`auto` | `max_completion_tokens` |
  `max_tokens`, default `auto`) that controls which wire field the output-token cap is
  sent under. `auto` is kind-derived: a `local` provider emits `max_tokens` (older
  self-hosted runtimes accept only that and **silently ignore** `max_completion_tokens`,
  which would drop the caller's cap), while every other kind emits `max_completion_tokens`
  (required by OpenAI o-series and other reasoning models). The translation IR still
  accepts both spellings inbound and always emits **exactly one** outbound — never both,
  since reasoning models reject the mere presence of `max_tokens`. The choice is a
  per-provider `AdapterQuirks` resolved once and applied at every adapter-construction site
  (proxy hot path and test-connection alike). Fixes local/legacy OpenAI-compatible
  endpoints silently dropping the token cap; existing `local` providers switch to
  `max_tokens` on migration (their endpoints accept it) while all other providers are
  byte-identical to before.
- 8020976: Layer 2 semantic routing (add-semantic-routing) turns the embedder foundation
  into real routing. When a `model:"auto"` request is Layer-1 ambiguous and the
  semantic layer is effectively enabled (instance flag + a loaded embedder +
  built anchor centroids + tenant preference), polyrouter embeds a versioned,
  newest-first serialization of the request and classifies it against bundled
  anchor centroids: a confident **high**/**low** band routes through the same
  `auto_high`/`auto_low` targets with `decision_layer='semantic'`, while a still-
  ambiguous verdict hands to cascade or the default tier exactly as before. Every
  Layer-2 fault — not ready, embed timeout, caller disconnect, a degenerate
  vector — degrades to that same flow with no delay beyond one bounded embed
  attempt and no fabricated telemetry (invariant 1). Four nullable telemetry columns
  (`semantic_band`/`semantic_score`/`semantic_source`/`semantic_revision`, an
  opaque provenance digest) ride the parent request rows with all-or-none +
  score-range DB checks, and the ordered Layer-1→Layer-2 classification trail is
  recorded on both the default-fall-through and cascade reasons. The auto-layers
  API and settings gain a `semantic` preference (backfilled from the structural
  preference, semantic⇒structural enforced, atomic dependency-aware normalization
  for older clients); the analytics request listing exposes the four fields
  verbatim and its `decision_layer` filter accepts `semantic`. No prompt text or
  vectors are ever logged or persisted.
- Updated dependencies [6c11c59]
- Updated dependencies [6c11c59]
- Updated dependencies [8020976]
  - @polyrouter/shared@0.7.0

## 0.7.0

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

- 7f0e62f: The body-capture card's buttons use the design system's real classes — "Purge
  all bodies" no longer renders as bare oversized text, and the consent/disable
  dialogs' actions follow the established primary/cancel/ghost idioms.
- Updated dependencies [7dc88d2]
  - @polyrouter/shared@0.6.0

## 0.6.0

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

- 717026d: The Auto performance card refreshes on every Routing-page visit instead of
  freezing at its first fetch (already-loaded numbers stay visible while the
  refetch replaces them), and switching its range now triggers the reload from
  the range action itself.
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
  - @polyrouter/shared@0.5.0

## 0.5.1

### Patch Changes

- ed54d74: Fix the Band-targets picker showing "default" while nothing is chosen: the
  placeholder option is now pinned as the select's resting state (at first
  render and after every apply) — the row's target line, not the picker, is
  what displays the current target.

## 0.5.0

### Minor Changes

- 246ced9: Band targets become dashboard-configurable (add-band-target-ui): a robust
  Routing-page section for `auto_high`/`auto_low` — the effective rule shown in
  the proxy's own deterministic order, atomic retargeting via PATCH, shadowed-
  duplicate disclosure with one-action cleanup, empty/unresolved targets flagged
  with their true fall-through consequence, a same-destination warning, a
  usability-driven "cascade needs both bands" note, range-framed unroutable
  counts beside the fix, snapshot-scoped writes with post-mutation reconciles
  (and a visible unverified state when verification fails), and a keyboard-
  operable grouped tier/model picker with effective-price labels. The pure
  routing-target parser moves to the shared root export (server re-exports
  unchanged) so the dashboard uses the canonical parser.

### Patch Changes

- Updated dependencies [246ced9]
  - @polyrouter/shared@0.4.1

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
- ed87f1b: Replace the tier editor's native add-model `<select>` with a styled, hand-rolled
  WAI-ARIA combobox: a single-tab-stop input that opens a provider-grouped listbox
  and filters case-insensitively by model id or provider name (a provider-name
  match keeps its whole group). Full keyboard operation (arrows with wrap,
  Home/End, Enter commits, Escape closes then clears, IME-safe), an honest
  "N of M models" count with an explicit empty state, price labels with their
  `· est.` provenance, and the same ordered-chain add semantics as before.
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

- 9e1a62e: feat(dashboard): add the polyrouter mark as the favicon

  An SVG favicon derived from the sidebar routing mark (accent + neutral tokens), with a
  `prefers-color-scheme` block so it stays legible on dark browser chrome. Served from the
  SPA's static assets — no third-party fetches, per the packaging rules.

- 9ba056f: feat(dashboard): the sidebar setup guide can be dismissed

  The "Setup guide" card gains an × control; dismissal persists per browser (like the
  theme preference), so the card stays gone across reloads. The setup flow itself is
  unchanged for anyone who keeps the card.

- 20b9668: fix(providers): credential field mislabeled "Base URL" for custom/local kinds

  In the add/edit provider form, selecting the Custom endpoint (or Local) kind labeled
  the API-key input as a second "Base URL" field with a URL placeholder. The kind
  definitions now label it "API key" with key-shaped placeholders; the dedicated Base URL
  field is unchanged.

- c6a2950: feat(routing): group the add-model dropdown by provider

  The tier "+ Add model…" dropdown now renders native `<optgroup>` sections — one per
  provider, labelled with the provider's name — with models sorted alphabetically inside
  each group and groups sorted by name. The Routing page also loads the provider list on
  mount so group labels resolve even when the Providers page was never visited.

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
