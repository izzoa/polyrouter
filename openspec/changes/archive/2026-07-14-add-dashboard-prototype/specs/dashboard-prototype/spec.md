# dashboard-prototype — delta

## ADDED Requirements

### Requirement: Dashboard shell with all prototype pages
The SPA SHALL render the prototype's shell — sidebar (brand, 8 nav items with active state and Requests/Providers badges, setup-guide card, theme toggle, instance footer) and topbar (page title/subtitle, Live pill, copyable `/v1` endpoint chip) — and switch between Overview, Requests, Costs, Agents, Providers, Routing, Limits, Settings, and Setup guide without a page reload.

#### Scenario: Navigation switches pages
- **WHEN** the user clicks a sidebar item (e.g. Requests)
- **THEN** the main area renders that page and the topbar title/subtitle update, with the nav item visually active

#### Scenario: Theme toggles and persists
- **WHEN** the user clicks the theme toggle
- **THEN** the dark token set applies via a root `data-theme` attribute and the choice survives a reload

### Requirement: Simulated data behind a single boundary
All dashboard data SHALL come from a local simulator module (model catalog with unit prices, seeded requests/providers/agents/tiers/limits/channels, and a live feed generating a new request on an interval), isolated so later changes can replace it with real API calls without touching page components. Simulated request costs SHALL be computed as `tokens × the catalog's unit prices`, matching the spec's cost formula (§7.5).

#### Scenario: Live feed updates the dashboard
- **WHEN** the live feed emits a new request
- **THEN** it appears at the top of the request tables with an entrance animation and the Overview stat cards tick up accordingly

#### Scenario: Data layer is swappable
- **WHEN** a later change replaces the simulator module's exports with API-backed equivalents
- **THEN** page components compile and render unchanged (they import only the data/state boundary, never generate data themselves)

### Requirement: Request tables with the routing-decision inspector
Request rows (Overview's recent-requests and the Requests page) SHALL show time, model, provider (with `sub`/`local` tags), tier, decided-by layer chip, tokens, cost (green for local/free, `~` suffix when estimated), latency, and status. Clicking a row SHALL open the inspector drawer showing: agent → router(layer) → provider flow; the step-by-step decision trace (L0/L1/L3 with pass/hit/skip/warn/error states); structural features when the L1 layer decided; usage & cost including the **price snapshot** and an estimated-usage note; and timing (routing decision, first token, total, protocol incl. translated cross-protocol calls).

#### Scenario: Inspecting an auto-routed request
- **WHEN** the user clicks a request whose decided-by chip is `structural`
- **THEN** the drawer opens with a decision trace beginning at L0 pass-through, the L1 structural-features grid, a price-snapshot line, and timing rows

#### Scenario: Requests page filters
- **WHEN** the user selects the Fallbacks filter chip
- **THEN** only rows with fallback status remain and the count label updates

### Requirement: Routing page interactions
Tier cards SHALL list their model chain with primary/fallback badges and per-model prices, support drag-to-reorder, removal, and an add-model select that enforces the 5-model cap with feedback. Auto-layer toggles SHALL flip L1/L3, while L2 Semantic is locked with cloud-tier messaging. Header rules SHALL display as `x-polyrouter-tier: <value> → <target>` rows with removal.

#### Scenario: Reordering a chain
- **WHEN** the user drags a fallback row above the primary
- **THEN** the chain order updates and badges recompute (new primary shown as Primary)

#### Scenario: The chain cap holds
- **WHEN** a tier already has 5 models and the user picks another from the add select
- **THEN** the chain is unchanged and a "Max 5 models per tier" toast appears

### Requirement: Management pages and modals
Agents (table + New agent → key-reveal modal with shown-once copy and per-harness snippet; rotate key; snippet view), Providers (cards with kind chip, health/circuit copy, Test and Sync actions; add-provider modal with kind picker, test-connection gate, SSRF/encryption note; subscription-ToS footnote), Limits (budget cards with progress, alert/block styling, resets copy; new-budget modal), and Settings (instance card, body-logging toggle defaulting off with metadata-only copy, notification channels with enable toggles and send-test feedback) SHALL behave as prototyped.

#### Scenario: Minting an agent key
- **WHEN** the user creates an agent from the New agent modal
- **THEN** a key-reveal modal shows a `poly_…` key marked shown-once with a copyable harness snippet, and the agent joins the table

#### Scenario: Add-provider gate
- **WHEN** the user has not run a successful test connection in the add-provider modal
- **THEN** the Add provider button stays disabled; after the simulated test succeeds it becomes active and adds a provider card

### Requirement: Onboarding setup guide
The Setup guide SHALL walk the prototype's three steps — connect an agent (name + platform → mint key → snippet), connect a provider (four kind cards with confirmation), routing ready (default chain preview) — with a stepper reflecting progress, finishing back on Overview.

#### Scenario: Completing onboarding
- **WHEN** the user finishes step 3 with "Open dashboard"
- **THEN** the app returns to Overview and the sidebar setup card reflects completed progress
