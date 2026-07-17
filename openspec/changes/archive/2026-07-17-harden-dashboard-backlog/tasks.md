# Tasks — harden the dashboard backlog

## A-26 — onboarding retry does not duplicate the provider
- [x] Reuse an already-created provider id (from onboarding state) on re-entry instead of
      calling `createProvider` again after a downstream failure.

## A-27 — single-flight guards on create/add mutations
- [x] Add `if (state.X.busy) return;` to `createAgent`, `addProvider`, `createTier`, `createRule`.

## A-28 — remove the inert body-logging toggle
- [x] Remove the Toggle in Settings; reframe as a read-only metadata-only assurance.
- [x] Delete the dead `bodyLog` state field and `toggleBodyLog` action.

## A-29 — real per-agent 24h figures on the Agents page
- [x] Load an `agent` breakdown over the last 24h; store agentId → {requests, spend}.
- [x] Render requests/spend in place of the `—` placeholders; drop the stale copy.

## A-30 — real version, no fabricated component versions
- [x] Inject `__APP_VERSION__` at build (vite `define` from the package version); declare its type.
- [x] Settings shows `v{__APP_VERSION__}` only — remove the fabricated `postgres 16 · redis 7`.

## A-31 — gap-honest requests timeseries
- [x] `timeseriesToChart` zero-fills missing buckets (inferred step) so uPlot draws dips to
      zero rather than interpolating across empty time.

## Verification
- [x] `npm run build`, lint, typecheck clean.
- [x] Frontend Vitest: appState (single-flight + onboarding-retry reuse), analytics
      (timeseries zero-fill), plus updated Settings/Agents.
- [x] Changeset added (user-facing dashboard behavior).
