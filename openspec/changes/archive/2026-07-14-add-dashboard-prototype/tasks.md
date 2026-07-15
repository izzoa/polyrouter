# Tasks: add-dashboard-prototype

## 1. Foundations

- [x] 1.1 `src/styles.css`: token system (light + `[data-theme='dark']`), keyframes, and classes for the repeated patterns (panel, chips, buttons, nav, table rows, toggles, drawer, modal, toast, bar rows); Geist font links in `index.html`
- [x] 1.2 `src/data/catalog.ts` (model catalog + prices + price/format helpers) and `src/types.ts` (Request with decision trace/features, Provider, Agent, Tier, Limit, Channel, …), strict-TS clean
- [x] 1.3 `src/data/simulator.ts`: faithful `gen()` port (5 scenario branches, feature grids, cost = tokens × unit prices) + seed data + live-feed start/stop
- [x] 1.4 `src/state/appState.ts`: store + actions (nav, theme persist, filters, selection, tier reorder/add/remove with cap-5 toast, layer toggles with L2 lock, rules, agents/providers/limits/channels actions, modal + onboarding state, toast/copy)

## 2. Shell & pages

- [x] 2.1 Shell: `App.tsx` (theme boot, live feed with `live` prop for tests), `Sidebar`, `Topbar`, `Toast`
- [x] 2.2 Overview page: range selector, 4 stat cards, requests-per-hour SVG chart with fallback dots + legend, spend-by-model bars, provider strip, recent-requests table
- [x] 2.3 Requests page: filter chips + full table (shared row component with Overview)
- [x] 2.4 Costs page: month card with saved-vs-list, free/paid split bar, cost-integrity card, by-model/provider/agent bars
- [x] 2.5 Agents + Providers pages with action buttons and footnotes
- [x] 2.6 Routing page: tier cards (drag-to-reorder, remove, add select, badges, prices), auto-layer toggles (L2 locked), header rules, degradation note
- [x] 2.7 Limits + Settings pages (budget cards, body-log toggle, channels with send-test)
- [x] 2.8 Setup guide: 3-step stepper, key mint + snippet, provider kinds, default-chain preview, finish → Overview

## 3. Inspector & modals

- [x] 3.1 Inspector drawer: header/status, flow chips, decision-trace timeline, structural-features grid, usage & cost (price snapshot, estimated note), timing block; overlay + close
- [x] 3.2 Modals: New agent, Key reveal (shown-once + snippet), Add provider (kind picker, gated add, SSRF note), New budget; overlay/stopPropagation behavior

## 4. Tests & verification

- [x] 4.1 Simulator tests: generated requests are catalog-valid, cost math matches unit prices, escalated/fallback branches carry the right traces/flags
- [x] 4.2 State tests: reorder, cap-5 add, remove, layer toggle + L2 lock, filter logic, limit creation
- [x] 4.3 Render tests (happy-dom, `live=false`): shell renders all nav; navigation switches pages; clicking a request opens the inspector with "Decision trace"; theme toggle flips the root attribute
- [x] 4.4 `npm run build`, `npm test -w packages/frontend`, `npm run lint` green; visual pass against the prototype via `npm run dev`; changeset added; TODOS.md updated (#18–#20 re-scoped notes + status board row)
