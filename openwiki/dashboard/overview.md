---
type: Architecture
title: Dashboard
description: Polyrouter's SolidJS frontend dashboard — 9 pages for monitoring requests, managing providers, configuring routing, viewing analytics, and managing budgets with StyleSeed design system.
tags: [dashboard, frontend, solidjs, design-system, styleseed]
resource: packages/frontend/src/App.tsx
---

# Dashboard

The polyrouter dashboard is a SolidJS + Vite SPA that provides a complete management interface for the LLM router. It communicates with the control plane via a typed fetch client with cookie-based authentication.

## Pages

| Page | Purpose |
|------|---------|
| **Overview** | KPIs, request charts, spend summary, 15s polling |
| **Requests** | Request log table with decision inspector |
| **Costs** | Cost breakdowns by model, provider, or agent |
| **Agents** | Manage API keys, 24h stats, harness selection |
| **Providers** | Manage providers (API key or [subscription OAuth](/openwiki/providers/subscription-oauth.md#how-it-works) connect), health checks, catalog sync, model price edit |
| **Routing** | Configure tiers, model assignments, fallback chains |
| **Limits** | Budget management with alert/block actions |
| **Users** | Admin user management — invite users, assign roles, disable accounts |
| **Accept Invite** | Redeem a single-use invite token to create an account |
| **Settings** | Account, notification channels, OAuth providers, prompt/response body capture, pricing catalog |
| **Setup** | 3-step onboarding wizard |
| **Login** | Authentication gate |

The Providers page surfaces per-model **listed price estimates** (flagged `estimated` when shown instead of a known billing price) and lets users edit model prices directly — see [Provider Adapters](/openwiki/providers/adapters.md#provider-listed-pricing-display-only) for the display-only invariant. OAuth-connected providers show their preset, token expiry, and a reauthorize action when `credential_error` is set.

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
  // ... more slices
}
```

Aggregate pages poll at 15-second intervals for near-real-time updates.

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
```

**Source**: `packages/frontend/src/data/api.ts`

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
| `Inspector` | Routing decision detail view (including matched routing header) |
| `RangeSelector` | Date range picker for analytics |
| `Modals` | Dialog system with focus management |
| `Toast` | Notification toasts |
| `Toggle` | Accessible toggle switch |
| `BodyCaptureCard` | Prompt/response body capture controls (Settings) |

## Pages Detail

### Overview

Displays KPIs (total requests, spend, success rate), request volume charts, and recent activity. Polls every 15 seconds.

### Requests

Paginated table of all LLM requests with filtering. The **Inspector** shows the full routing decision: which tier was selected, which provider served the request, which header chose the route (when applicable), fallback chain attempts, and cost breakdown.

### Costs

Cost analytics with three grouping dimensions: by model, by provider, or by agent. Uses µUSD (micro-dollars) internally for precision.

### Agents

Manage API keys (`poly_...`), view 24-hour usage stats, select harness type (OpenAI/Anthropic), and rotate keys.

### Providers

Add/edit LLM providers, trigger model catalog sync, view health status, and manage credentials.

### Routing

Configure routing tiers, assign models to tiers with position ordering, set up header-based routing rules, and enable auto-routing layers.

### Limits

Create and manage budgets with configurable scopes (global or per-agent), windows (day/week/month), and actions (alert or block).

### Settings

Account management, notification channel configuration (SMTP and Apprise), OAuth provider settings, prompt/response body capture controls, and pricing catalog status.

**Body Capture** (selfhosted only): opt-in prompt/response body capture with three modes — `off` (metadata only, default), `errors_only` (errors and cascade escalations), `all` (every request). Per-agent overrides (`always`/`never`) refine the global mode. Captured bodies are encrypted with the same `PROVIDER_CREDENTIAL_KEY` as provider credentials, stored alongside the request log, and purged daily per the configured retention window (7/30/90/365 days, or explicit keep-forever). The card shows drop count, last purge time, and a consent gate for enabling. See [Data Model](/openwiki/data-model/schema.md#budgets--notifications) for schema details.

**Pricing Catalog** (add-pricing-refresh-ui): shows catalog entry count, newest version, last refresh result, and scheduler status (configured enabled, mode permitted, effective enabled, cron). The daily auto-refresh pulls the LiteLLM catalog and appends effective-dated versions. On by default; opt out with `PRICING_REFRESH_SCHED_ENABLED=false`.

### Setup

3-step onboarding wizard for new installations:
1. Create admin account
2. Add first provider
3. Configure routing
