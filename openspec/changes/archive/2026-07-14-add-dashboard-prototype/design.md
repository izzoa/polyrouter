# Design: add-dashboard-prototype

## Context

The source of truth is `Polyrouter Prototype.dc.html` (Claude Design, project `c06afc7f…`): a 1440×900 interactive prototype with a design-canvas template DSL (`sc-for`/`sc-if`/`{{ }}`/`style-hover`), a CSS-variable token system (light + dark), and a `DCLogic` class holding state, a model catalog, and a request simulator. The port targets the existing SolidJS + Vite package from change #1, TS strict.

## Goals / Non-Goals

**Goals:** pixel-faithful port of layout/tokens/copy; all prototype interactions working; simulated data isolated behind a swappable module; strict TS; tests for the simulator, state actions, and page rendering.

**Non-Goals:** real data, auth, uPlot, routing library, responsive/mobile layout (prototype is desktop-first; §9 dashboard is a desktop tool).

## Decisions

1. **Template DSL → Solid primitives.** `sc-for` → `<For>`, `sc-if` → `<Show>`, `{{ }}` bindings → signals/store reads, `onClick="{{ fn }}"` → `onClick={fn}`. The prototype's single `renderVals()` object decomposes into per-page components reading a central store.
2. **State: one `createStore` app state + actions module** (`src/state/appState.ts`) mirroring the prototype's `this.state` (page, theme, range, filter, requests, tiers, autoLayers, rules, providers, agents, limits, channels, modal + form fields, onboarding, selection, toast). Actions are plain exported functions mutating the store — the exact seams #18–#20 will re-point at APIs.
3. **Styling: tokens + classes, inline for one-offs.** The prototype's `body{--vars}` token block and dark overrides move verbatim into `src/styles.css` under `:root`/`[data-theme='dark']` on `<html>`. Repeated patterns (panel/card, table grids, chips, buttons, nav items, toggles, drawer, modal, toast, bar rows) become classes — required anyway because `style-hover` has no inline equivalent; genuinely one-off styles stay inline in JSX. Grid column templates stay inline (they're per-table data, not theme).
4. **Simulator is the future service boundary.** `src/data/catalog.ts` (model catalog + prices), `src/data/simulator.ts` (faithful `gen()` port: the six decision-trace scenarios, feature grids, cost = tokens × unit prices), `src/data/seed.ts` (initial requests/providers/agents/tiers/limits/channels **and the static analytics datasets** — pages never embed data). `App` starts the live feed (default 4s) via `onMount`/`onCleanup`; a `live` prop disables it for tests. *(Amended after codex review:)* each `RoutedRequest` **carries its own `inPrice`/`outPrice` snapshot**, and all request rendering (tables, inspector, cost formatting) reads request fields only — never the mutable catalog — mirroring the product's cost-immutability rule and keeping rows from out-of-catalog custom providers renderable. A token guard invalidates in-flight simulated connection tests when the add-provider form changes.
5. **Chart stays hand-rolled SVG** (path computed from the 24-point series exactly like the prototype). uPlot is deliberately deferred to #19 with real time-series — pulling it in for a static mock adds a dependency without exercising it honestly.
6. **Theme** via `data-theme` on `document.documentElement`, persisted to `localStorage('polyrouter-theme')`; tokens defined for both. (Prototype used `document.body`; html-level lets CSS load before first paint.)
7. **Drag-to-reorder** ports the prototype's HTML5 drag handlers (`dragstart`/`dragover` reorders live/`dragend`) on tier chain rows; cap of 5 enforced in the add action with a toast.
8. **Fonts: Geist + Geist Mono via Google Fonts `<link>`** for prototype parity. Flagged: a self-host-first app should bundle its fonts — recorded as a packaging concern for #22 rather than blocking the port.
9. **Clipboard + toast** port as `navigator.clipboard.writeText` in a try/catch plus a 1.8s toast, exactly as prototyped.

## Risks / Trade-offs

- [Large hand-port; visual drift from the prototype] → styles copied literal-by-literal from the source file (kept in scratchpad during the port); page-by-page eyeball against the design after `npm run dev`.
- [Mock data could read as real] → the topbar "Live" pill and simulated feed are the prototype's own design; the data layer is one module, so #18's swap is mechanical, and nothing persists.
- [Google Fonts request from a privacy-first app] → accepted for the prototype; #22 bundles fonts (noted in its TODOS entry).
- [State-based navigation loses deep links] → matches the prototype; #18 adds URL routing when real pages/auth land.

## Migration Plan

Replaces the placeholder `App.tsx`/`App.test.tsx` from #1; no data, no schema, no API surface. Rollback = revert the frontend package.

## Open Questions

None — the prototype is the complete visual/behavioral spec.
