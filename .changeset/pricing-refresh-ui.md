---
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
'@polyrouter/shared': patch
---

Pricing stays current by itself (add-pricing-refresh-ui): a **daily automatic
LiteLLM catalog refresh — on by default** (self-host only; one env line opts
out: `PRICING_REFRESH_SCHED_ENABLED=false`) on its own BullMQ queue riding the
existing guarded refresh path, plus a Settings **Pricing catalog** panel for
admins — entry count, newest version, a literal "never refreshed" callout, the
schedule state, and a Refresh-now button. Refresh completions land in a new
append-only run ledger (recorded atomically with the version apply; a `+0`
unchanged pull counts as fresh; garbage bodies fail instead of advancing
freshness), `GET /api/pricing/status` exposes it, and cloud instances neither
schedule nor allow catalog mutations (enforced at the service boundary; boot
seeding exempt). New prices apply to new requests only — recorded costs never
change.
