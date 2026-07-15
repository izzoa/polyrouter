# Proposal: add-dashboard-prototype

> Implements the approved UI design **"Polyrouter Prototype.dc.html"** from the Claude Design project *Polyrouter UX/UI spec* (`claude.ai/design/p/c06afc7f-2654-419a-b90a-e38b1eed2dd2`), user-directed out of band from the TODOS.md order. Spec context: §2 (user flows), §9 (dashboard), §3.4 (frontend stack).

## Why

The dashboard's UX is designed and approved as an interactive prototype, but `packages/frontend` is still the change-#1 placeholder shell. Porting the prototype now — against simulated data — front-loads the entire UI surface (§9) so backend changes #18–#20 become "swap the data layer for real APIs" instead of "design + build the UI under pressure". The prototype itself is simulation-driven, so a faithful port is fully functional without any backend.

## What Changes

- Replace the placeholder SPA in `packages/frontend` with a SolidJS port of the prototype: sidebar shell + 9 pages (Overview, Requests, Costs, Agents, Providers, Routing, Limits, Settings, Setup guide).
- Port the **routing-decision inspector drawer** (decision trace, L1 structural features, usage & cost with price snapshot and `~estimated` flag, timing/protocol) — the spec's transparency feature (§1, §9).
- Port the interactions: light/dark theme, live-feed simulation, request filters, drag-to-reorder tier chains (max 5, primary/fallback badges), auto-layer toggles (L2 locked as cloud-tier), header rules, budget cards + new-budget modal, notification channels with send-test, agent key mint/rotate with harness snippets, add-provider modal (kind picker, test connection, SSRF copy), onboarding stepper.
- All data comes from a **local simulator module** (`src/data/`) with the same model catalog, request generator, and live feed as the prototype — structured as the future service boundary for #18–#20.
- polyrouter branding throughout (`poly_…` key prefixes, `x-polyrouter-tier` header copy).

## Capabilities

### New Capabilities

- `dashboard-prototype`: the simulated-data dashboard SPA — shell, pages, inspector, modals, theme, live feed; the UI contract that later changes bind to real APIs.

### Modified Capabilities

_None. (`app-bootstrap`'s SPA-serving requirements are unchanged — this replaces the shell's content, not its serving contract.)_

## Impact

- **Code:** `packages/frontend/src/**` rewritten (components, pages, state, data simulator, stylesheet); `index.html` gains font links. No backend, no schema, no new runtime dependencies beyond fonts.
- **Downstream:** #18 `add-dashboard-core`, #19 `add-dashboard-analytics`, #20 `add-dashboard-config` re-scope to wiring real APIs/auth into this UI via the `src/data/` boundary (TODOS.md notes updated).

## Non-goals

- **No real API calls, no auth** — every number is simulated locally; #18+ owns real data.
- **No uPlot yet** — the Overview chart is the prototype's hand-rolled SVG; uPlot arrives with real time-series in #19.
- **No client-side router library** — page switching is state-based like the prototype; deep-link URLs can land with #18.
- **No backend/proxy work** of any kind.
