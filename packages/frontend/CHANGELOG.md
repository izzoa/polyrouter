# @polyrouter/frontend

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

## 0.12.3

### Patch Changes

- fb200c3: Fixed: the OpenClaw connection snippet — shown in Agents → New, returned by the agent-create
  API, and printed in the README — described a config file OpenClaw cannot read (TOML at
  `~/.openclaw/config.toml` with an `[llm]` table; OpenClaw's only config is JSON5 at
  `~/.openclaw/openclaw.json`). Following it failed silently. The snippet now emits the real
  format: a `models.providers` entry for the router with `api: "openai-completions"` and a
  single `auto` model, selected as the default via `agents.defaults.model`.
- c189b8f: Fixed: every page's subtitle in the top bar ("last 24 hours", "every routed call, with its
  why", …) sat a few pixels below the page title's baseline instead of sharing it. The subtitle
  was baseline-aligned against the icon-and-title group, and a flex group exports its first
  item's baseline — the icon's, which has no text baseline, so its bottom edge was used. The
  title row is now a single flex line: title and subtitle share a real text baseline, and the
  icon centers itself exactly where it was before.

## 0.12.2

### Patch Changes

- 01067ef: Fixed: the Overview's "Spend by model" panel had no metric switch, so the spend/tokens toggle
  added in 0.12.0 only worked on the Costs page — even though the panel is the same panel and the
  preference is shared. It now offers the switch too, and its heading, empty state and units
  follow the selection. Flipping it on either page changes both, which is what a shared
  preference should mean.

  Also fixed a smaller problem the same panel had: navigating to the Overview after switching to
  tokens on Costs briefly rendered the token-ranked models under a "Spend by model" heading —
  the right values for the wrong models, with the bars not in descending order — until the
  refetch landed.

- e321406: Fixed: token counts wrapped to two lines in the requests table once real traffic arrived. At
  production magnitudes "87.2k in / 1.5k out" is wider than the column, so most rows rendered as
  two lines. Tokens now read `87.2k↑ 1.5k↓` — the same information in two thirds of the width,
  with the in/out wording kept for screen readers. The Tokens figure on the Overview does the
  same; it was wrapping at phone widths for the same reason.

## 0.12.1

### Patch Changes

- 62a9bd5: Fixed: five controls were smaller than the 24px minimum hit target at desktop width — the
  setup guide's dismiss button, the three setup step buttons, and a routing band-target dropdown.
  The 24px floor is required at every width (WCAG 2.5.8 AA) and the stylesheet only applied it to
  controls carrying a component class, so anything styled inline had no floor above the narrow
  breakpoint. Controls now get the floor by being controls, not by being remembered.
- d3f4554: Fixed: a dozen small symbols in the interface — the copy, close, chevron, drag-handle and
  escalation marks, the chart legend keys and the status dot — were text characters the bundled
  Geist fonts do not contain, so each was drawn with whatever symbol font the viewer's operating
  system happened to supply. The same control looked different on macOS, Linux and Windows. They
  are now inline vector icons from one registry, or styled elements where the mark is just a
  coloured shape, so the dashboard renders the same everywhere and fetches nothing extra.

  Also fixed, found while doing it: an escalated request was marked only by a small decorative
  arrow, so screen readers never announced escalation at all, and a completed setup step was
  indicated by a checkmark and a green ring with no text equivalent. Both states now carry
  accessible text.

- 6dd551c: Fixed: the dashboard could fail to load entirely — a blank white page — on hosts whose browser
  reports a locale tag that the formatting APIs reject. The charting library builds a number
  formatter from the browser's raw reported locale while its module is being loaded, so a
  non-conforming tag (`en-US@posix`, as some containers and kiosk browsers report) threw before
  the dashboard had rendered anything at all. The reported locale is now checked and, if
  unusable, replaced with the one the browser itself resolved for that machine; a host reporting
  a normal locale is untouched and formats exactly as before.

  Also added: if the dashboard ever fails to start for any reason, it now says so instead of
  showing an empty page — a blank page is indistinguishable from a crashed server or a bad
  deploy, and sent operators looking in the wrong place.

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

- 4b40aab: The Requests page no longer silently goes stale, and a finished request stops saying it is
  still running.

  The page froze its time window the moment it loaded and nothing ever triggered another
  fetch, so a request completing while you watched could never appear — however long you
  waited, with nothing on screen saying so. The in-flight band added in the previous release
  arguably made that worse: live rows above a frozen list read as "this page is current".

  It now refreshes on the same cadence as the Overview page, routed through the shared refresh
  budget so a burst of traffic cannot turn into a burst of queries. That only applies while
  you have not paged: once you have clicked "Load more", refreshing would throw away the pages
  you asked for, so instead the page tells you how many newer requests exist and offers to load
  them. Taking the offer returns you to a fresh first page. If that check fails, it says so
  rather than quietly implying the list is up to date.

  Separately, a request that has just finished no longer displays as "Running" while its
  record is being written. It now reads "Finishing" and stops pulsing. That was wrong on the
  Overview card too — it was simply harder to notice there, because the handoff usually
  completes in well under a second.

- 4a179c3: The Requests page now shows requests as they run, the way the Overview card does.

  Until now the page only ever showed finished requests — and, less obviously, only the ones
  that had finished before you opened it. Its window is frozen at the moment of load, so a
  request settling while you watched could never appear in the list, however long you waited.

  Running requests are now rendered above the completed rows, from the same shared live set
  the Overview card reads. They are deduped against the rows that page is actually showing,
  which matters more than it sounds: a request that has just settled lingers briefly while its
  durable row is written, and arriving at the page during that moment re-freezes the window to
  include it — without the dedupe the same request would appear twice.

  The band respects the page's filters where it honestly can. Explicit and Auto select on the
  routing decision, which is known the moment a request is admitted, so those work. Fallbacks
  and Escalated depend on how a request _ends_, which a running one has not done — so the band
  empties rather than guessing at rows that might not match once they settle. Both use the
  same filter mapping the completed list uses, so the two can never disagree about what "auto"
  means.

  Nothing about the paginated list changes: its window, its cursor and "Load more" behave
  exactly as before, and the band never inserts into it.

  Also fixes a latent ordering bug in the shared live-request state. A snapshot still in
  flight could previously land after newer state and overwrite it — settling a request that
  had only just started, or resurrecting one that had finished. It now loses to any newer
  update, whether that came from another fetch or from the event stream.

- 28a025d: The dashboard's pages now adapt to a narrow viewport. Every page previously rendered a
  desktop layout regardless of screen width — the sidebar alone took 53% of a phone screen,
  and the requests table needed roughly 1020px to stay legible.

  Below 768px the sidebar collapses to an icon rail that expands, on demand, into a labelled
  navigation panel carrying the account menu and setup guide. Multi-column page layouts drop
  to fewer columns, control rows wrap instead of overflowing, and page gutters tighten.

  Tables adapt to the width **they** actually get rather than the viewport's — a table sits
  inside the content pane minus the sidebar and gutters, so at a 1025px window the requests
  table receives only about 765px. Each of the four tables reflows to stacked records at its
  own measured threshold, keeping every field, every row action, and — for a request row —
  the same single control, the same accessible name, and the same link into the inspector.

  Interactive controls now meet a 24px minimum target at every width and 44px below the
  narrow threshold or on a touch pointer, so a tablet gets comfortable targets even at a
  width nowhere near a phone's.

  **Desktop rendering is unchanged**, with one deliberate exception: three controls that
  shipped below the 24px accessibility minimum (`.icon-x`, `.drag-handle`, `.link-accent`)
  grew to meet it. That parity is pinned by a browser test measured against the released
  v0.11.0 build.

  Detail drawers and dialogs keep their current geometry for now; they are the next phase.

- 05c4723: The dashboard's overlays now work on a phone. Phase 1 adapted every page but deliberately
  left the drawers and dialogs alone, so you could browse the dashboard on a phone without
  being able to open anything on it.

  Tapping a request opened a 440px inspector panel on a 390px screen: its left edge sat at
  −50px, and at 320px wide it hung 120px off the edge. Nothing caught that, because a
  `position: fixed` surface overhangs the viewport without adding any document overflow — so
  the page-level check passed while a third of the drawer was unreachable. Three of the six
  modal kinds were worse: the provider form is 878px tall at 320px wide against a 568px
  screen, and its Save button sat 310px past the bottom of a fixed backdrop, where no scroll
  could reach it.

  Below 768px the inspector, all six modal kinds and both confirmation dialogs are now
  presented as bottom sheets — full width, height-capped so the page stays visible behind
  them, and scrolling internally so nothing is stranded. It is the same DOM restyled rather
  than a second component, so dismissal, focus trapping, layer ordering and accessible names
  are literally the same objects at both widths; a test keeps a dialog open across the
  breakpoint and asserts the element, its layer token and the focused control all survive the
  crossing.

  The on-screen keyboard is handled for the first time. Nothing in the app read the visual
  viewport before, so a sheet anchored to the bottom of the screen would have sat behind the
  keyboard, and the model picker — which measured against `window.innerHeight`, a value that
  does not shrink on iOS — would have opened underneath it. Sheets and the picker now measure
  against what is actually visible, the picker re-measures if the keyboard arrives after it
  opens, and pinch-zoom is correctly distinguished from a keyboard so zooming to read a value
  does not send a sheet up the screen.

  Safe-area insets are honoured on bottom-anchored surfaces, so a sheet's actions clear the
  home indicator, and the toast — which had no width and shrink-wrapped into a 160×103px
  block at 320px wide — now spans the screen.

  **Desktop rendering is unchanged**, pinned by geometry captured from every overlay before
  any of this was written.

- 8b1f235: Tier chains can now be reordered on a touch device, and the chain row is readable on a
  phone at all.

  Reordering was wired to HTML5 drag-and-drop, which browsers never fire for touch input. So
  on a phone the Routing page rendered, invited interaction, and could not perform its
  function: the fallback order was fixed at whatever it was when it was created. The only
  other path was `Alt`+arrow on the drag handle, needing a physical keyboard and discoverable
  only by reading the handle's label.

  Each chain row now carries explicit move-up / move-down controls, disabled at the ends of
  the chain. They share the mover with the keyboard path rather than reimplementing it, so
  the three transports cannot drift apart — a test reorders the same chain by drag, by
  keyboard and by tap and asserts all three persist an identical result. They appear where a
  drag is unavailable: below the narrow threshold, or wherever _any_ available pointer is
  coarse. That second condition matters more than it looks, because a laptop with a mouse and
  a touchscreen reports a fine pointer while being exactly the device that cannot drag with a
  finger.

  The row itself was also broken, which measuring it turned up. At 320px it had 194px of
  content width and put 253px in it: the model identifier — the name of the thing being
  reordered — computed to **zero width**, the price label was painted on top of it, and the
  row's action was clipped off the edge. None of that registered as document overflow, which
  is why it had gone unnoticed. The row now separates its information from its actions and
  wraps, so the identifier is legible and every control is reachable. The header hint stops
  telling touch users to drag.

  **Desktop rendering is unchanged** — same single-line row, same controls, no move buttons —
  pinned against geometry captured before the work began.

### Patch Changes

- d848132: Fixed: one account's spend figures could remain visible after switching to another.

  The same defect as the request-view fix, on a different surface. The Observe pages' summary,
  timeseries and cost breakdowns were guarded only against stale _range_ replies — the guard
  orders responses within one account and cannot see an account change. So signing out and in
  as a different user in the same browser session left the previous account's spend totals,
  request counts, timeseries and by-model/provider/agent breakdowns on screen, and a response
  already in flight could still commit afterwards.

  The account boundary now invalidates and clears those figures, and resets their loading and
  error state so a mid-load switch cannot latch a spinner. The guard is applied in the shared
  slice runner, so every one of those loaders is covered at once rather than each having to
  remember.

  As with the request-view fix, no server-side isolation failure was involved: every response
  was correctly scoped to whoever asked for it. This was about what the client kept and what it
  allowed to commit after the principal changed.

- 977b8b4: Fixed: the two body-capture confirmation dialogs — "Capture prompt & response bodies?" and
  "Turn capture off" — announced themselves to assistive technology as modal dialogs while
  implementing none of it. Keyboard focus could Tab straight out of them into the page behind,
  and Escape did not close them, even though `aria-modal` told a screen reader the rest of the
  page was hidden. Both now trap focus, close on Escape, and return focus to the control that
  opened them.

  Changed: the account menu now closes when you press Tab, letting focus continue into the
  page, which matches how menus are expected to behave. Previously Tab moved focus through the
  page behind while the menu stayed open.

  Under both: overlay layering is now decided in one place. Which surface takes Escape, which
  one traps Tab, and which one paints on top all derive from a single ordering, so they cannot
  disagree — they previously could, and did.

- 0d5ec8c: Fixed: one account's request data could remain visible after switching to another.

  Signing out and signing in as a different user in the same browser session left parts of the
  previous account's Requests page behind. The request list, its cursor and its frozen range
  window were never cleared, and a page load or "Load more" already in flight could still
  commit afterwards — so the incoming user could be looking at the previous user's requests.

  More seriously, the request inspector's selection and its **cached payloads** were not
  cleared either. Where prompt/response capture is enabled, that state holds the request and
  response text itself — the one category of data polyrouter otherwise refuses to persist. It
  is now cleared at the account boundary, along with the list.

  The identity boundary also now resets the page's loading and error state, so an account
  change landing mid-load leaves the page ready to reload rather than showing a spinner that
  never resolves.

  Nothing about this was a server-side isolation failure: every response was correctly scoped
  to whoever asked for it. The defect was entirely in the client, in what it kept and what it
  allowed to commit after the principal changed. The filter selection is deliberately kept —
  it is a display preference, not another account's data.

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
- 26a7d58: Dashboard pages are now addressable by URL. Each page has a `#/<page>`
  fragment, so pages can be bookmarked, the browser's Back/Forward buttons move
  along the page axis, and a link from outside the product can open a specific
  page. An unrecognized fragment falls back to the default page as before.

  Authorization is unchanged and now enforced on the route itself: the
  admin-only Users area cannot be reached by URL as a non-admin — the requested
  page is held until the session resolves, then admitted only if permitted. The
  accept-invite link flow is untouched; its token fragment is never parsed as a
  page nor written to history.

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
