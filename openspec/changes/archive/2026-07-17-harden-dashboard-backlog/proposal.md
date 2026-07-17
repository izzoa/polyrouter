# Harden the dashboard backlog (A-26 … A-31)

## Why

Six frontend backlog findings from `FABLE_AUDIT.md` (Appendix A) — duplicate-write races, a
control that pretends to do something it can't, fabricated/placeholder display, and a
misleading chart:

- **A-26 — an onboarding step-2 retry mints a duplicate provider.** `obConnectProvider`
  creates a provider, then syncs models / assigns a tier. If any of those later steps fails,
  the user retries — and `createProvider` runs again, minting a second provider for the same
  intent (the first is already persisted).
- **A-27 — create/add mutations lack the single-flight guard the save mutations have.**
  `createAgent`, `addProvider`, `createTier`, `createRule` set `busy` but never check it on
  entry, so a double-submit (the submit control isn't reliably disabled) fires two POSTs and
  creates duplicates. `saveBudget`/`saveChannel` already guard with `if (state.X.busy) return`.
- **A-28 — the "Log prompt & response bodies" toggle is inert.** It flips only local state and
  calls no API; worse, the system stores **metadata only** by design (invariant 8) and has no
  body-persistence mechanism at all — so the toggle offers a capability that does not exist.
- **A-29 — the Agents page shows placeholder `—` for per-agent requests/spend and stale copy**
  ("figures arrive with the analytics change") — but the analytics API already exposes an
  `agent` breakdown dimension, so real 24h figures can be shown.
- **A-30 — the Settings "Version" line is fabricated** (`v0.4.1 · postgres 16 · redis 7`): a
  made-up app version plus backend component versions the browser cannot know.
- **A-31 — the requests timeseries visually interpolates across gaps.** The server returns one
  point per **non-empty** bucket; the chart maps them straight into uPlot, which draws a line
  across missing buckets — falsely implying steady activity where there was none.

## What changes

- **A-26:** Track the created provider id on the onboarding state; on entry reuse an
  already-created provider (re-sync/re-assign from it) instead of minting a new one, so a
  retry after a downstream failure does not duplicate.
- **A-27:** Add `if (state.X.busy) return;` to `createAgent`, `addProvider`, `createTier`,
  `createRule` — matching the existing save-mutation single-flight guard.
- **A-28:** Remove the fake toggle; reframe the panel as a read-only assurance that the system
  is metadata-only (bodies are never stored). Drop the dead `bodyLog` state + `toggleBodyLog`.
- **A-29:** Load a per-agent 24h breakdown (requests + spend) on the Agents page and render it
  in place of the `—` placeholders; remove the stale "arrives with the analytics change" copy.
- **A-30:** Inject the real app version at build (`__APP_VERSION__` from the package version)
  and show only that; drop the fabricated Postgres/Redis versions the frontend cannot know.
- **A-31:** Zero-fill missing buckets in `timeseriesToChart` (empty bucket = 0 requests) so the
  chart draws honest dips to zero instead of interpolating across gaps.

## Impact

- Affected specs: `dashboard-core` (onboarding/mutation single-flight + honest settings),
  `dashboard-analytics` (per-agent figures + gap-honest timeseries).
- Affected code: `packages/frontend/src/state/appState.ts`,
  `packages/frontend/src/pages/{Settings,Agents}.tsx`,
  `packages/frontend/src/data/analytics.ts`, `packages/frontend/vite.config.ts`.
- No API/schema change. A-29 uses the existing `agent` breakdown dimension.
