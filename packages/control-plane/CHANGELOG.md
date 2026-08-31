# @polyrouter/control-plane

## 0.15.4

### Patch Changes

- 1ea0ad9: **An out-of-credit or permission-denied provider now falls back instead of failing the request.** A request routed to an OpenRouter model came back `bad_request · HTTP 402` with the provider's own words withheld, `$0.00` of attempt cost, and a fallback chain that was never walked — and the agent received an OpenAI-shaped `400 invalid_request_error`, the one class a well-behaved client will never retry. The cause was a single catch-all: `classifyResponse` named 400/401/404/408/409/413/422/429/5xx and mapped **every other 4xx** to `bad_request`, the only kind for which `shouldFallback` is false. So "I do not recognize this status" was answered with the most destructive value in the taxonomy — the chain abandoned, the breaker left closed so the next request hit the same dry account, and the body withheld as a validation echo, hiding the one string ("Insufficient credits…") that explained the outage.

  The 4xx map is now explicit end to end. **402** is `insufficient_funds`: fallback-eligible (another provider serves the identical request) and breaker-tripping (a dry account rejects everything until a human tops it up). **405/415** are provider misconfiguration; **410** is refined by body exactly as 404 already was; **451** is `policy_block`, the one deliberate walk _stop_ — another member might well serve a legally-denied request, which is precisely why the router must not try. Anything else 4xx is `upstream_rejected`: fallback-eligible and **strictly breaker-neutral**, so a response we could not classify can neither disable a provider nor erase its accumulated real failures.

  **401 and 403 no longer share a kind, which is the real fix for the breaker trip.** Every provider protocol polyrouter targets returns 401 for an invalid or revoked credential and 403 for a permission decision — an unsupported region, a model the key may not call, an org policy. Mapping 403 to `auth` read a _per-model_ denial as a _provider-wide credential failure_ and opened the breaker on a provider answering every other request; one moderation-flagged prompt could take a healthy provider offline for every agent on the instance. `auth` is now 401 only. A 403 is `permission` (or `content_policy` when its body carries a moderation marker, read from nested provider metadata as well as the outward type/code) — both fallback-eligible, neither tripping, so a missed marker costs a label rather than a provider.

  Streamed errors get the same taxonomy pre-commit, and the adapter's cross-field classification is now _carried_ to the router rather than re-derived from the outward type, so a credit, policy, or permission marker that appears only in the wire `code` no longer misroutes. The mid-stream commit boundary is untouched: after the first token the model stays committed and any failure terminates the stream. Provider error bodies for the new kinds are withheld under markers naming their own reason — the **kind** carries the diagnosis, and no status whose body semantics providers do not guarantee is trusted to be free of echoed prompt content.

- Updated dependencies [1ea0ad9]
  - @polyrouter/data-plane@0.9.2

## 0.15.3

### Patch Changes

- 0925190: **A semantic source that loses its boot build now recovers on its own.** v0.16.2 made a failed centroid build rare by giving the anchor phases their own budget; it did not make one recoverable. A phase that spent its budget set its source to null for the life of the process — Layer 2 (and, for the workload phase, research/writing detection) stayed dead until someone restarted the container, and the restart was a coin flip on the same contention that caused the failure. Boot is exactly when a host is most contended, so the one moment the build runs is the one moment it is most likely to lose.

  A phase that fails for a **retryable** cause — a spent budget, an embed timeout, an admission saturation — now arms three scheduled slots at +1m/+5m/+15m inside one latched generation. A **degenerate** result never retries: its inputs are fixed for the process's lifetime, so a repeat is near-certain and would bury the one error an operator must act on. That split is exhaustive over the embed-failure kinds and enforced at compile time, every validation path raises a typed error rather than a bare `Error`, and anything unclassified is treated as terminal — the safe direction.

  Because this runtime executes inference **synchronously on the event loop**, no admission rule can protect live traffic from a rebuild's occupancy; the only lever is whether it runs. So the first two slots start only when the model is embed-quiet and abandon — installing nothing partial — if traffic resumes, while **the last slot runs regardless**. That is what makes recovery a guarantee rather than a hope: eligibility for the quiet gate turns on arrival spacing, not load, so a lightly loaded instance with steady spacing would otherwise never qualify. The cost is bounded but not free: up to three phase executions per failed source, one of them unconditional.

  What recovery does **not** promise, stated rather than implied: no request ever awaits a rebuild and none fails because of one, but a dispatched native slice still delays whatever is behind it, and a rebuild taking admission on the shared gate can make a concurrent request skip Layer 2 — including a band classification refused during a workload rebuild. Each slot's outcome is distinguishable in the log (`closed-unrun`, `ran-abandoned`, `ran-failed`, succeeded), and an exhausted generation says so rather than leaving an operator to infer from silence whether anything is still being tried.

  No new environment key, no API field, no migration, and no change at all for an instance whose centroids build at boot.

- Updated dependencies [0925190]
  - @polyrouter/data-plane@0.9.1

## 0.15.2

### Patch Changes

- 9c5cef1: **Layer 2 no longer loses a boot to a busy host.** The bundled band anchors and the workload anchors — 210 embeds — were built through the seam bounded by `SEMANTIC_TIMEOUT_MS`, the rail whose whole purpose is that no _live request_ stalls on the embedder. No request waits on a boot embed, and per-anchor cost on ordinary self-host hardware sits in the same tens-of-milliseconds range as that 50ms rail, so the build was effectively a lottery every startup: the same image and config could come up with L2 ready one day and `semantic classifier UNAVAILABLE — … (embed exceeded 50ms bound)` the next, taking research/writing workload detection with it and staying dead until a restart that might not help.

  Boot-path embedding now runs on its own bound, and each anchor phase is bounded by a total wall-clock budget instead — because `onApplicationBootstrap` blocks `listen()`, a generous per-embed bound would trade a lost capability for a hung instance. A phase that runs out gives up, names the **budget** in its error (a host-speed fault, whose remedy is nothing like the bad-bundle one it used to be reported as), logs the elapsed time on success so an operator can see headroom before it becomes an outage, and lets the instance start; the band and workload phases keep their independent outcomes. `SEMANTIC_TIMEOUT_MS` is untouched in meaning and default — the point is that the two bounds have different jobs. The two seams share one admission gate, so `SEMANTIC_CONCURRENCY` keeps bounding in-flight native work across both rather than per-seam.

  **The dashboard stops sending you after a variable that was already right.** `GET /api/routing/auto-layers` adds `semanticEmbedderReady` beside the existing halves (additive; `semanticAvailable` and the `PUT` shape unchanged), splitting "no model bundle" from "bundle loaded, centroids failed" — states that were indistinguishable, so the L2 row and the Workload-targets row both said "no ready model; check `SEMANTIC_MODEL_PATH`" even when the model had loaded perfectly. With the embedder up, both now name the centroid build and the boot log, and never a half that is already satisfied.

## 0.15.1

### Patch Changes

- b315041: **Auto performance no longer 500s once the counterfactual basis has a real price.** `GET /api/analytics/auto` bound the `auto_high` basis's per-1M rates straight into `integer_column * $n`, and Postgres types an untyped parameter from the operator it meets — so it resolved each rate to `integer` and rejected the first fractional one (`22P02 invalid input syntax for type integer: "1.4"`), failing the whole request rather than the savings block. Any basis model whose input or output price is not a whole number of dollars per 1M tokens — i.e. essentially every catalog model — took the Auto-performance card down with it. The rates are now pinned to `double precision`, the same float arithmetic `computeCost` used to write the actual costs the counterfactual is subtracted from; integer-rate results are bit-identical to before. The savings e2e now prices its basis fractionally (1.4 / 4.4), which is what let this reach a release.

  Background jobs also report **why** they failed: a BullMQ `failed` handler logged only `err.message`, which for a wrapped `DrizzleQueryError` is the SQL — the actual reason (`ENOTFOUND`, a dropped connection, a SQLSTATE) sat unread in `cause`. All seven schedulers (budget eval, notify delivery, weekly summary, calibration, body purge, semantic learning, pricing refresh) now log the cause chain, clipped to one line.

## 0.15.0

### Minor Changes

- 21bc98a: **Semantic workloads (Epic W, W-3).** The flag-gated semantic module gains a second workload source: for a structural-`none` `auto` request it embeds ONCE (bounded by the existing semantic rails) and compares the vector to bundled, versioned per-class anchors; `research` / `writing` are recorded with `workload_source = 'semantic'` and a `semantic/<taxonomy>/<classifier>/<digest>` revision, and route through the existing `auto_workload` rules — only when the winning class leads every other by `SEMANTIC_WORKLOAD_MARGIN` (0.05) and clears `SEMANTIC_WORKLOAD_MIN_SIM` (0.20). Precedence: a structural class always wins; the semantic source never emits `code` / `vision` / `structured`; Layer 2 reuses the same vector (a request is never embedded twice; a failed stage embed skips Layer 2 for that request); every fault degrades to the unclaimed flow; the quad follows W-2's atomic commit. New auto-layers fields `semanticWorkloadAvailable` / `semanticWorkload` (rides the semantic preference); the Workload-targets card's `research` / `writing` rows go live exactly when that is effective and name the missing half otherwise; the mix footnote and README follow. No migration.
- f952107: **Workload targets (Epic W, W-2).** An `auto_workload` routing rule binds ONE workload class (`code` / `vision` / `structured`; `research` / `writing` reserved for the semantic source) to a `tier:` or `model:` target. An `auto` request whose Layer-1 workload verdict carries that class is CLAIMED before band targets, Layer 2, and the cascade — served by the target's chain with `decision_layer = workload`, the band verdict still recorded but never acted on. Unset / unresolvable / empty targets and `none` leave routing byte-identical; explicit models and the tier header still win; any stage fault degrades to the unclaimed flow. New `routing_rule.workload_class` column + CHECKs (migration 0027); rule CRUD validates the class/type pairing; `GET /api/analytics/auto` adds `workloadMix.classes[].routed` and the listing filter accepts `layer=workload`; the Routing page gains a **Workload targets** card and the Auto-performance card shows routed counts with a band-figure disclosure; the inspector marks routed rows.
- 955ef28: **Workload-scoped bands (Epic W, W-4).** Band rules (`auto_high` / `auto_low`) may now carry a `workload_class` as a SCOPE — that band target applies only to requests whose deciding workload class matches — and the proxy resolves a class's scoped pair before the generic pair for Layer-1 and Layer-2 band routing and for the cascade plan (cheap/strong resolved per band with the scope; each falls back to the generic rule independently; an existing scoped rule with an unusable target makes that band unroutable for the class — never a silent substitution). The Workload-target claim still precedes the bands. Routing reasons gain ` scope=<class>` (every cascade-constructed reason too); a cascade whose selected cheap leg was class-scoped contributes no learning evidence (its revision binds to the generic cheap chain); the Auto-performance savings basis is the generic strong target and `savings.basis.scoped` says when scoped rules exist. Migration `0028` (NOT VALID) replaces the W-2 pairing CHECK with the three-way scope CHECK; rule CRUD validates the scope shapes. The Band-targets card gains a per-workload bands block (class picker, STRONG/CHEAP rows, claim-first / unusable-claim notes, scope-isolated set/clear/cleanup).
- 78eefcb: `auto` requests now record a **workload** class (code / vision / structured / none — telemetry only): a pure structural classifier over the existing Layer-1 feature vector rides every L1 evaluation and lands four columns on parent request-log rows (`workload_class/score/source/revision`, migration 0026). Nothing routes on it yet. The inspector shows a workload chip, `GET /api/analytics/auto` gains `workloadMix` (per-class requests + reported-basis spend on both ledgers, with unpriced/coverage/revision disclosures), and the Auto-performance card gains a "Workload mix" block. New optional `ROUTING_WORKLOAD_THRESHOLDS` (`codeShare`, `codeMinChars`).

### Patch Changes

- Updated dependencies [21bc98a]
- Updated dependencies [f952107]
- Updated dependencies [955ef28]
- Updated dependencies [78eefcb]
  - @polyrouter/shared@0.14.0
  - @polyrouter/data-plane@0.9.0

## 0.14.0

### Minor Changes

- 9dd9226: Per-attempt fallback forensics, and a breaker probe that can actually recover a
  slow provider.

  A failed request's trail no longer collapses four different causes into one
  word. A chain member skipped because its provider's circuit breaker was open —
  never contacted at all — now records `skip@model` in the routing reason instead
  of impersonating an upstream `unavailable` failure, and `status=error` rows
  additionally persist structured per-attempt failure metadata (new
  `request_log.attempt_failures` jsonb, migration 0025): per walked member its
  mapped error kind, upstream HTTP status when one existed, a dispatched-vs-
  skipped flag, the cascade leg, and a recorder-set terminal marker — aggregated
  across BOTH cascade legs (previously the superseded cheap leg's failures were
  dropped entirely at escalation). Structure only: the shape has no free-text
  field, so the no-verbatim rule for superseded members stands. The metadata rides
  the request listing's safe view, and the inspector renders a structural
  "Fallback trail" — skips labeled "skipped — circuit open (provider not
  contacted)" — plus an honest ERROR-card note when the terminal member was a
  never-dispatched skip.

  The half-open breaker probe now runs with widened patience: its first-byte and
  idle bounds double (capped at the 1 h ceiling), the derived event/dispatcher
  bounds follow, and the probe's lease is granted, renewed, and TTL-protected at
  the widened duration — on the buffered path too, whose body bytes now feed lease
  renewal. A provider tripped by workload-shaped timeouts (heavy prompts on slow
  models) can therefore pass its recovery probe on the same workload and close the
  breaker, instead of being re-tripped indefinitely; a genuinely hung provider
  still times out typed at the widened bound and re-opens.

### Patch Changes

- Updated dependencies [9dd9226]
  - @polyrouter/shared@0.13.0
  - @polyrouter/data-plane@0.8.0

## 0.13.1

### Patch Changes

- 7151caa: One healthcheck contract across both image variants, and an honest L2 hint.

  Both Docker image variants (baseline and `-semantic`) now declare the identical
  exec-form Node health probe: it targets `/api/health` on the configured `PORT`
  (default 3001) and needs no `wget`/`curl`, so changing `PORT` no longer requires
  a healthcheck override, and the documented Node probe form runs unchanged on
  both variants — overrides that shell out to base-image utilities remain outside
  the contract (the baseline's former BusyBox-`wget` probe had no binary to run
  on the `-semantic` image's Debian-slim base).

  `GET /api/routing/auto-layers` additionally reports the semantic capability's
  two halves — `semanticFlagEnabled` (`semantic ∈ ROUTING_AUTO_LAYERS`) and
  `semanticClassifierReady` (embedder + centroids) — with `semanticAvailable`
  preserved as their conjunction. The Routing page's unavailable-L2 hint now names
  exactly the missing half(s) instead of unconditionally saying "set
  `SEMANTIC_MODEL_PATH`" (which was wrong on a `-semantic` image that only lacked
  the `ROUTING_AUTO_LAYERS` entry).

## 0.13.0

### Minor Changes

- 72329e3: Output-cap guardrails: on router-chosen routes (tiers, headers, rules, default, auto), polyrouter now plans each fallback chain against the models' known `max_output_tokens` (ingested from the LiteLLM catalog, refreshed daily). Members that cannot satisfy the request's `max_completion_tokens` are deferred behind members that can (recorded as `output_cap_deferred` in the routing reason — note this means capacity can outrank a subscription member's quota-first position across stages, never within one); when every member's known cap is insufficient, the chain is walked in configured order with each attempt clamped to its own cap (`output_cap_clamped`, honest `finish_reason: "length"` on truncation) instead of dying on a guaranteed provider 400. Explicitly-named models are never touched (provider parity), unknown caps never defer or clamp, a cap-lookup failure fails open, and the synthesized Anthropic `max_tokens` default is now capped to the dispatched model's known limit.

### Patch Changes

- Updated dependencies [72329e3]
  - @polyrouter/shared@0.12.0
  - @polyrouter/data-plane@0.7.0

## 0.12.1

### Patch Changes

- fb200c3: Fixed: the OpenClaw connection snippet — shown in Agents → New, returned by the agent-create
  API, and printed in the README — described a config file OpenClaw cannot read (TOML at
  `~/.openclaw/config.toml` with an `[llm]` table; OpenClaw's only config is JSON5 at
  `~/.openclaw/openclaw.json`). Following it failed silently. The snippet now emits the real
  format: a `models.providers` entry for the router with `api: "openai-completions"` and a
  single `auto` model, selected as the default via `agents.defaults.model`.

## 0.12.0

### Minor Changes

- 6257b25: The Costs breakdowns can now be ranked by tokens as well as spend, and every token figure
  counts the work you were actually billed for.

  The dashboard could tell you what each provider cost and nothing about how much work it
  did — there was no token figure per provider, model or agent anywhere. That hides the
  question a router exists to answer: a provider with a large share of tokens and a small
  share of spend is doing cheap work, and heavy spend against few tokens is the opposite. The
  three Costs panels now share a spend/tokens selector, and switching it **refetches** rather
  than re-sorting: the API returns a top-N, so re-ordering the rows already on screen would
  have shown "top by tokens" while silently dropping any provider that leads on tokens and
  trails on spend.

  **Two corrections to what "tokens" means, both of which move numbers you may be watching.**

  Token totals now sum **both cost ledgers**. An escalated cascade attempt consumes tokens the
  provider meters and bills, and spend has always counted them — the token figures did not, so
  they under-reported real usage on every request the cascade escalated.

  Token totals now also include **cached tokens**. `input_tokens` is recorded as _uncached_
  input, because the adapters subtract cached tokens out and record them separately; a figure
  built from input + output alone therefore omitted a cached workload's largest component
  while looking exact.

  Both changes flow through the summary, the timeseries and the breakdowns together, so no two
  token numbers in the product can mean different things. **The Overview's token headline will
  read higher** than it did for the same range — that is the fix, not a display change, and it
  is larger the more caching and cascade escalation your traffic does. The headline now shows
  a cached component beside its in/out split.

  Nothing that decides anything reads these figures: budget enforcement, alert thresholds and
  routing use their own spend-only paths and are untouched, as is every recorded cost and
  price snapshot. `GET /api/analytics/breakdown` gains an optional `metric` parameter
  (`spend` by default, so existing callers are unaffected) and returns the four token
  components plus an `estimatedTokens` figure disclosing how much of the total came from
  providers that did not report usage.

## 0.11.0

### Minor Changes

- 5ff4c44: Auto-performance now surfaces per-agent L1 signal quality. When a stable
  agent's structural score collapses to a near-constant (its modal two-decimal
  score bucket covers ≥ 50% of ≥ 50 ambiguous-band requests in range), the
  Auto-performance card names the agent, the score, and the share — with
  availability-aware guidance (pin a tier, or enable/configure L2 · Semantic,
  which evaluates exactly that ambiguous slice). Below the evidence floor no
  verdict is rendered, and a neutral coverage line discloses unassessed agents
  so insufficient evidence never reads as healthy. `GET /api/analytics/auto`
  gains the per-agent `signalQuality` block. Read-time aggregation only — no
  routing behavior, hot-path, or schema change.
- 6862e31: Notification emails are now branded HTML with a link back into the dashboard.
  Every message ships as `multipart/alternative`: a text-only client sees exactly
  the same wording as before, an HTML client sees a laid-out message carrying the
  event and a link to the relevant page (a provider alert opens Providers, budget
  alerts open Limits, and so on). Invite and password-reset emails share the same
  layout.

  The layout is deliberately asset-free — a text wordmark, no images, web fonts,
  or externally hosted anything — so it renders identically on an instance that
  isn't publicly reachable and triggers no remote fetches.

  **To get the links, set `APP_URL` to the address your users actually reach the
  dashboard at, then restart.** They appear only from a routable origin: with the
  default (`http://localhost:3001`) the link is omitted rather than sending a
  `127.0.0.1` URL that would be dead in a recipient's inbox — and setting `APP_URL`
  to a loopback value explicitly does the same, deliberately. A LAN or `.local`
  address works and is often the right one for a self-hosted instance. The value is
  read at boot, so a restart is required after changing it.

  Chat channels (Apprise) now carry a per-event severity, so a provider-down or
  budget-block notification is visually distinct from an informational summary at
  the target, with the page link on its own line.

### Patch Changes

- Updated dependencies [5ff4c44]
  - @polyrouter/shared@0.11.0

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

- Updated dependencies [7965e88]
  - @polyrouter/shared@0.10.0

## 0.9.1

### Patch Changes

- c0bd7f7: The `CALIBRATION_*` and `EVENTS_*` knobs now actually reach the container. The shipped
  `docker-compose.yml` declares an explicit `environment:` allow-list rather than passing the
  whole `.env` through, and neither namespace was on it — so all six calibration variables
  (which the README's own `.env` reference told operators to set) and all seven dashboard
  event-stream variables were silently dropped, leaving both subsystems on their defaults
  with no error and nothing in the logs to explain why. They are now declared as optional
  bare-key pass-throughs alongside the existing `ROUTING_*`, `BUDGET_*` and `PROXY_*` tunables.

  Unset behaves exactly as before — an undeclared variable stays undefined and the app applies
  its registered default — so this changes nothing for a deployment that was not setting them.
  For one that _was_ setting them in `.env` and silently getting defaults, the values now take
  effect on the next `up`, which is the behaviour the documentation always described.

  `SEMANTIC_*` is deliberately left out: those belong to `docker-compose.semantic.yml` and are
  only meaningful with the `-semantic` image, and `SEMANTIC_MODEL_PATH` stays baked into that
  image.

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

- Updated dependencies [4282ffd]
  - @polyrouter/shared@0.9.0

## 0.8.0

### Minor Changes

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

### Patch Changes

- 8fee339: Record the matched value for `x-polyrouter-tier` remap rules (record-tier-header-value).
  The routing resolver now records the matched owned rule value for a request routed by
  an `x-polyrouter-tier` remap rule (a dashboard Header rule on the tier header) — the
  tier-ask category the client sent (e.g. `shopping`) — so the request inspector's DECISION
  `header` row renders `x-polyrouter-tier: shopping` instead of the header name alone. The
  value flows through the existing `routing_header_value` column and the inspector's
  existing `<name>: <value>` rendering; no schema, migration, API, or frontend change. The
  recorded value is the OWNED config string that matched (config-side provenance, identical
  to the direct-tier lookup's tier key), never arbitrary client bytes — so invariant 8 holds.
  Rules on any OTHER header are unchanged: they still record the header name only, because a
  configured value on an arbitrary header can be a credential (fail-closed, no denylist).
- Updated dependencies [4d9cbd5]
- Updated dependencies [8fee339]
  - @polyrouter/shared@0.8.0
  - @polyrouter/data-plane@0.6.1

## 0.7.0

### Minor Changes

- 6c11c59: Layer-2 learning loop (add-semantic-learning): per-tenant learned centroids that
  track each tenant's own outcome-labeled traffic, opt-in and default OFF. When a
  cascade outcome settles for a request Layer 2 found ambiguous AND whose tenant had
  learning ON at decision time, the request's in-memory embedding is labeled from the
  cascade result (quality-passed → `low`, quality-gate escalation → `high`, everything
  else → nothing) and accumulated in bounded volatile memory, flushing to Redis only a
  ≥ `SEMANTIC_LEARNING_MIN_COHORT` sum — no persisted value is ever a single raw
  embedding. A daily BullMQ sweep folds fixed-window pending evidence into learned
  centroids under rails (min fresh samples, capped EMA, SPHERICAL drift clamp toward the
  bundled anchors, cooldown, exact evidence-revision match), crash-atomically across
  Redis + Postgres via separate revocation-epoch and active-generation counters (rotate
  → stage → Postgres `FOR UPDATE` CAS + idempotent scalars-only audit → promote).
  Classification supersedes bundled with learned centroids only when every read-time gate
  passes (learning on, `(epoch, generation)` match, TTL, evidence-revision, both labels
  validate); any gate failure or Redis fault falls back to bundled — never the layer's
  skip. A one-action revert bumps the revocation epoch (Postgres-first, race-proof) then
  clears Redis. Privacy is absolute: raw embeddings live only in request-scoped or
  bounded volatile memory; the only persisted artifacts are aggregates, Redis-only, under
  domain-separated HMAC tenant digests, never in Postgres, a log, a metric, or an API
  response. Gated entirely on the optional semantic stack — the baseline image is
  unaffected. New env: `SEMANTIC_LEARNING_{MIN_COHORT,MIN_SAMPLES,ALPHA,MAX_DRIFT,COOLDOWN_H,STATE_TTL_D,MAX_COHORTS,SCHED_ENABLED,SCHED_CRON}`.
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
- 5e7e489: The Layer-2 semantic-embedder foundation lands as a flag-gated optional
  module (add-semantic-embedder). Setting `SEMANTIC_MODEL_PATH` to a local
  model bundle (versioned manifest + WordPiece vocab + ONNX weights) activates
  a bounded local embedding runtime: warmup at boot, per-embed hard timeout,
  input cap, no-queue admission semaphore, content-derived model revision, and
  fail-fast boot on a broken bundle (the port never binds). Unset, the module
  is absent entirely — the runtime dependency is an optional peer that npm
  never auto-installs, the baseline image stays ORT- and model-free
  (CI-asserted), and behavior is unchanged. `ROUTING_AUTO_LAYERS` is now a
  validated token list (unknown layer names reject boot instead of silently
  disabling routing) and accepts an inert `semantic`; the auto-layers API
  reports `semanticAvailable`. Embedded text and vectors are never logged or
  persisted. Routing does not consume the embedder yet — that arrives with
  add-semantic-routing.
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

### Patch Changes

- Updated dependencies [6c11c59]
- Updated dependencies [6c11c59]
- Updated dependencies [5e7e489]
- Updated dependencies [8020976]
  - @polyrouter/shared@0.7.0
  - @polyrouter/data-plane@0.6.0

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
