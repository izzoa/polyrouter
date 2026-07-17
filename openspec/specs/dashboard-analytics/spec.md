# dashboard-analytics Specification

## Purpose
TBD - created by archiving change add-dashboard-analytics. Update Purpose after archive.
## Requirements
### Requirement: The Observe pages render real aggregates over a selected range

The dashboard's Overview and Costs pages SHALL render real analytics from the `/api/analytics` API over the user-selected range (`24h`/`7d`/`30d`), replacing the prototype simulator: Overview shows spend, request count, tokens, success/fallback/escalation rates, a requests-over-time chart, top models by spend, and a recent-requests list; Costs shows period spend, a free/paid/unpriced split, and spend broken down by model, provider, and agent. Changing the range SHALL refetch. An empty range SHALL render a zero-state, never NaN or a broken chart.

#### Scenario: Selecting a range refetches real aggregates

- WHEN a user switches the range on Overview or Costs
- THEN the page refetches the summary/timeseries/breakdown for that range and renders the returned numbers (not seeded/simulated values)

#### Scenario: An empty range renders a zero-state

- WHEN the selected range contains no requests
- THEN the cards/chart/breakdowns render zeros/an empty state rather than NaN or an error

### Requirement: Every request exposes a readable routing decision (the transparency feature)

The Requests page SHALL list the owner's request logs and, for each, expose its **tokens, cost, latency, model, and a readable `decision_layer` + `routing_reason`** (spec §1/§15). The decision inspector SHALL render the decision layer and the routing-reason string **generically** — whatever layer produced the request, with no dependency on any specific routing layer being present — plus the usage/cost breakdown and timing. It SHALL render the request's **immutable snapshot** cost and unit prices (invariant 4) and MUST NOT recompute cost against the current catalog.

#### Scenario: A request shows its decision layer and reason

- WHEN a user opens a request in the inspector
- THEN it shows the request's `decision_layer` and the verbatim `routing_reason`, its model/provider/tier, input/output (and cache) tokens, the snapshotted unit prices, and the served cost plus this request's attempt cost combined into a micros-exact total, latency, and status

#### Scenario: The inspector renders any decision layer

- WHEN a request was decided by a layer the UI has no special case for
- THEN the inspector still renders that layer's name and reason (a neutral rendering), never blanks or errors

#### Scenario: Displayed cost is the immutable snapshot

- WHEN a model's price is later changed
- THEN an already-recorded request still displays its original snapshotted cost/prices in the table and inspector (no live re-price)

### Requirement: The request list is keyset-paginated and filterable

The Requests page SHALL page through the log via the API's keyset cursor ("load more" until exhausted) **over a range window frozen when paging began** (so a shifting client clock cannot skip boundary rows), and SHALL apply **all** filter chips server-side, mapping status/escalation to their query params and the multi-value decision-layer chips to a **comma-separated `layer`** the API filters as a set. Paging SHALL not duplicate or skip rows. The `requests` endpoint SHALL accept a multi-value `layer` (rejecting an empty/whitespace segment) and filter the log to any of the given layers before paginating.

#### Scenario: Load more appends the next page over a frozen window

- WHEN a user has a page of requests and requests more (even as wall-clock time advances)
- THEN the next keyset page is appended in order with no duplicated or skipped rows, using the same range window as the first page, until the cursor is exhausted

#### Scenario: A multi-value layer filter narrows the list server-side

- WHEN a user filters to the "explicit" or "auto" group (each covering several decision layers), or by fallbacks / escalated
- THEN the API filters to exactly the matching decision layers / status / escalation (so pagination never yields an empty page mid-cursor), and clearing the filter restores the full list

### Requirement: Per-agent request and spend figures come from real aggregates

The Agents page SHALL display each agent's recent request count and spend from the real
analytics aggregate (the `agent` breakdown dimension over a fixed recent window), not a static
placeholder. Until the figures load they MAY show a neutral loading/blank state, but the page
SHALL NOT present permanently-blank placeholder cells alongside copy implying the data is not
yet available.

#### Scenario: Agent rows show real recent figures

- WHEN the Agents page has loaded and an agent has recent activity in the window
- THEN that agent's row shows its real request count and spend for the window (not a `—`
  placeholder), and an agent with no activity shows a zero/neutral value — not stale "coming
  soon" copy

### Requirement: The requests timeseries represents empty buckets honestly

The requests-over-time chart SHALL represent a bucket with no requests as **zero**, not as an
interpolated line across the gap. Because the server returns one point per non-empty bucket, the
client SHALL fill the missing buckets (at the series' bucket interval) with a zero value so the
chart dips to zero over idle periods rather than drawing a straight line that falsely implies
continuous activity.

#### Scenario: An idle period reads as zero, not interpolated activity

- WHEN the timeseries has a gap (one or more buckets with no requests between two non-empty
  buckets)
- THEN the chart shows the intervening buckets at zero (a dip to the baseline), not a line
  interpolated across the empty span

