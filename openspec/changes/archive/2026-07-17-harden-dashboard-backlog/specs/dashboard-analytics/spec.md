## ADDED Requirements

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
