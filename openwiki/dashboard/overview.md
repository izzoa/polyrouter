---
type: Architecture
title: Dashboard
description: Polyrouter's SolidJS frontend dashboard — pages for monitoring requests, managing providers, configuring routing, viewing analytics, budgets, the L2 semantic dashboard with learning card, and the StyleSeed-locked design system.
tags: [dashboard, frontend, solidjs, design-system, styleseed, semantic, layer-2]
resource: packages/frontend/src/App.tsx
---

# Dashboard

The polyrouter dashboard is a SolidJS + Vite SPA that provides a complete management interface for the LLM router. It communicates with the control plane via a typed fetch client with cookie-based authentication (Vite proxy in development, same-origin in production).

## Pages

| Page | Purpose |
|------|---------|
| **Overview** | KPIs, request charts, spend summary, 15s polling |
| **Requests** | Request log table with decision inspector (matched routing header, decision trail, L2 verdict) |
| **Costs** | Cost breakdowns by model, provider, or agent |
| **Agents** | Manage API keys, 24h stats, harness selection, key rotation |
| **Providers** | Manage providers (API key or [Subscription OAuth](/openwiki/providers/subscription-oauth.md#how-it-works) connect), health checks, catalog sync, per-model `max_tokens_spelling` and price edits |
| **Routing** | Configure tiers, model assignments, fallback chains, band targets, **L2 semantic dashboard** with learning card |
| **Limits** | Budget management with alert/block actions |
| **Users** | Admin user management — invite users, assign roles, disable accounts |
| **Accept Invite** | Redeem a single-use invite token to create an account |
| **Settings** | Account, notification channels, OAuth providers, prompt/response body capture, pricing catalog |
| **Setup** | 3-step onboarding wizard |
| **Login** | Authentication gate |

The Providers page surfaces per-model **listed price estimates** (flagged `estimated` when shown instead of a known billing price) and lets users edit model prices directly — see [Provider Adapters](/openwiki/providers/adapters.md#provider-listed-pricing-display-only) for the display-only invariant. OAuth-connected providers show their preset, token expiry, and a reauthorize action when `credential_error` is set.

The Requests page Inspector now also surfaces the L2 semantic verdict (band, score, source, revision) when Layer 2 evaluated the row, and a `semantic_source` provenance chip alongside the existing decision-layer badge.

## Architecture

### App Shell

```
┌─────────────────────────────────────────┐
│ Topbar (theme toggle, user menu)        │
├──────────┬──────────────────────────────┤
│ Sidebar  │  Page Content                │
│ (nav)    │  <Switch> routes             │
│          │                              │
└──────────┴──────────────────────────────┘
```

The `App` component manages an auth state machine with four states: `loading` → `gate` (login) → `error` → `ready` (dashboard).

**Source**: `packages/frontend/src/App.tsx`

### State Management

State is managed with SolidJS stores and context-based dependency injection:

```typescript
interface AppState {
  // Navigation
  page: Page;
  // Auth
  auth: AuthView;
  // Realized data
  agents: Agent[];
  providers: Provider[];
  models: Model[];
  tiers: Tier[];
  // L2 surfaces
  autoLayers: AutoLayersView | null;
  semanticLearning: SemanticLearningStatus | null;
  // ... more slices
}
```

Aggregate pages poll at 15-second intervals for near-real-time updates. The Routing page re-evaluates `autoLayers` and `semanticLearning` on every visit so a backend change is reflected without a hard reload.

**Source**: `packages/frontend/src/state/appState.ts`

### API Client

The typed fetch client (`data/api.ts`) provides:

- Cookie-based authentication
- `ApiError` class with status and message
- Typed DTOs for all entities
- Vite proxy in development, same-origin in production

```typescript
// Example usage
const agents = await api.listAgents();
const analytics = await api.getAnalytics({ from, to, groupBy: 'model' });
const semanticLearning = await api.getSemanticLearningStatus();
```

**Source**: `packages/frontend/src/data/api.ts`

## Routing Page — L2 Semantic Dashboard

The Routing page is where Layer 2 lives in the UI. Three sections:

1. **Auto layers** — the structural/cascade/semantic toggle trio. Each row shows the layer's available/unavailable state honestly:
   - `semanticAvailable === false` because no bundle → "Off instance-wide (set `SEMANTIC_MODEL_PATH`)"
   - `semanticAvailable === false` because the bundle is broken → "Layer 2 unavailable (bundle invalid)"
   - `semanticAvailable === true` → the toggle is interactive, on/off switches the per-tenant preference
   - When on, the tenant's preference is normalized down (semantic implies structural; cascade implies structural).

2. **Band targets** — `auto_high` and `auto_low` are dashboard-configurable. Each shows the resolved tier chain (primary + fallback count) and flags any degraded state.

3. **Learning card** (`add-semantic-dashboard` D3) — shown whenever Layer 2 is effective for the tenant. Renders a pure view-model (unit-testable):

```typescript
interface SemanticLearningVm {
  enabled: boolean;
  samplesLine: string;             // "learning from 12 low · 5 high"
  source: 'learned' | 'bundled';
  sourceLine: string;              // "active: learned centroids" / "active: bundled anchors"
  lastAppliedLine: string;         // "applied Jul 3, 2026" / "never applied"
  staleReason: string | null;      // honest degradation copy when a promoted centroid is inactive
  showRevert: boolean;             // offered whenever a centroid was promoted this epoch
  generation: number;
}
```

The card carries:

- The opt-in learning toggle (separate from the semantic toggle — both must be on to contribute evidence)
- Fresh-sample count per label
- The currently-active classification source (`learned` or `bundled`) with honest copy
- The numeric audit history table — `apply`, `discard_revision`, `revert` events with date, sample counts, drift/similarity scalars
- A confirmed one-click revert (bumps the revocation epoch)

**Honest-degradation rule**: a promoted centroid whose embedder or revision moved under it shows `source: bundled` with the reason `a learned centroid exists but is inactive (embedder or revision changed) — routing on bundled anchors`. The card never claims learning is "active" when the router is actually on bundled.

**Source**: `packages/frontend/src/data/semanticLearning.ts`, `packages/frontend/src/data/semanticLearning.test.ts`.

## Auto-Performance (L2 Slice)

The Routing page's auto-performance section gained a **semantic slice** (`add-semantic-dashboard` D2):

- Evaluated/routed-per-band view (`high`/`low`/`ambiguous`)
- The four-way outcome split — quality-passed, quality-gated escalation, provider-fault escalation, cancelled
- Bundled/learned source breakdown — what fraction of verdicts were served by each classification source
- Residual-cascade labeling — keeps pre/post-enable cascade figures comparable so the semantic toggle's effect is visible without lying about before/after

This data comes from the analytics endpoint filtered on `decision_layer='semantic'` plus the `semantic_source` column.

**Source**: `packages/frontend/src/data/autoPerf.ts`.

## Request Inspector — L2 Surfacing

The Requests page inspector now displays L2 information when present:

- A semantic verdict block with `band`, `score`, `simHigh`, `simLow` (rounded to 4 decimals)
- The `semantic_source` provenance chip (`bundled` / `learned`) inline with the existing decision-layer badge
- The `semantic_revision` string — a content-derived digest that identifies the embedder + anchor set (and the `(epoch, generation)` for learned centroids)
- The full ordered `routing_reason` trail — `structural:ambiguous s=...` then `semantic:high s=... src=...`

No request text, no embedding vector — those are invariants 1 + 8 (no fabricated telemetry, no disclosure).

**Source**: `packages/frontend/src/components/Inspector.tsx`.

## Design System (StyleSeed)

The frontend follows a locked design system defined in [`STYLESEED.md`](/STYLESEED.md):

| Property | Value |
|----------|-------|
| Accent color | `#4F5DFF` |
| Elevation | Flat borders (no shadows) |
| Density | Compact |
| Fonts | Geist Sans / Geist Mono |
| Themes | Light + dark mode |

### CSS Variables

Status colors use semantic CSS variables:
- `--status-green` — success, healthy
- `--status-amber` — warning, degraded
- `--status-red` — error, critical

### Quality Gate

All UI changes must pass the `/ss-score` agent skill gate (score ≥ 80). The scoring evaluates:

- Contrast ratios (WCAG AA)
- Keyboard operability
- Focus management
- Reduced motion support
- Design token adherence

### Accessibility

- **Keyboard-first**: All interactive elements are real `<button>` elements with visible focus
- **ARIA attributes**: Proper roles, labels, and live regions
- **Focus management**: Dialog tab loops, focus restoration on close
- **Reduced motion**: Respects `prefers-reduced-motion`
- **Contrast**: WCAG AA compliant in both themes

## Components

| Component | Purpose |
|-----------|---------|
| `Sidebar` | Navigation with page links |
| `Topbar` | Theme toggle, user menu |
| `Chart` | uPlot-based request/spend charts |
| `RequestTable` | Paginated request log with sorting |
| `Inspector` | Routing decision detail view (decision layer, matched routing header, L2 verdict, tokens, snapshotted cost, latency) |
| `RangeSelector` | Date range picker for analytics |
| `Modals` | Dialog system with focus management |
| `Toast` | Notification toasts |
| `Toggle` | Accessible toggle switch |
| `ModelPicker` | Tier/model selection (add-model flow) |
| `BodyCaptureCard` | Prompt/response body capture controls (Settings) |

## Pages Detail

### Overview

Displays KPIs (total requests, spend, success rate), request volume charts, and recent activity. Polls every 15 seconds.

### Requests

Paginated table of all LLM requests with filtering. The **Inspector** shows the full routing decision: which tier was selected, which provider served the request, which header chose the route (when applicable), fallback chain attempts, the full L1→L2→cascade reasoning trail, L2 verdict (band/score/source/revision), tokens, snapshot-priced cost, and latency.

### Costs

Cost analytics with three grouping dimensions: by model, by provider, or by agent. Uses µUSD (micro-dollars) internally for precision.

### Agents

Manage API keys (`poly_...`), view 24-hour usage stats, select harness type (OpenAI/Anthropic), and rotate keys.

### Providers

Add/edit LLM providers, set the **per-provider `max_tokens_spelling`** (auto/max_completion_tokens/max_tokens, default `auto`), set per-call timeouts (`first_byte_timeout_ms`, `idle_timeout_ms`, range 1 s to 1 h, NULL = inherit), trigger model catalog sync, view health status, and manage credentials.

### Routing

Configure routing tiers, assign models to tiers with position ordering, set up header-based routing rules, configure `auto_high`/`auto_low` band targets, and enable auto-routing layers (structural / cascade / **semantic**) plus the **L2 learning loop**. The L2 section includes the real toggle (when `semanticAvailable` is true), the learning card, and the semantic slice of the auto-performance view.

### Limits

Create and manage budgets with configurable scopes (global or per-agent), windows (day/week/month), and actions (alert or block).

### Settings

Account management, notification channel configuration (SMTP and Apprise), OAuth provider settings, prompt/response body capture controls, and pricing catalog status.

**Body Capture** (selfhosted only): opt-in prompt/response body capture with three modes — `off` (metadata only, default), `errors_only` (errors and cascade escalations), `all` (every request). Per-agent overrides (`always`/`never`) refine the global mode. Captured bodies are encrypted with the same `PROVIDER_CREDENTIAL_KEY` as provider credentials, stored alongside the request log, and purged daily per the configured retention window (7/30/90/365 days, or explicit keep-forever). The card shows drop count, last purge time, and a consent gate for enabling. See [Data Model](/openwiki/data-model/schema.md#budgets-notifications--body-capture) for schema details.

**Pricing Catalog** (`add-pricing-refresh-ui`): shows catalog entry count, newest version, last refresh result, and scheduler status (configured enabled, mode permitted, effective enabled, cron). The daily auto-refresh pulls the LiteLLM catalog and appends effective-dated versions. On by default; opt out with `PRICING_REFRESH_SCHED_ENABLED=false`.

### Setup

3-step onboarding wizard for new installations:
1. Create admin account
2. Add first provider
3. Configure routing