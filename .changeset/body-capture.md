---
'@polyrouter/control-plane': minor
'@polyrouter/data-plane': minor
'@polyrouter/frontend': minor
'@polyrouter/shared': minor
---

Opt-in prompt/response body capture (add-body-capture) — the invariant-8 door,
**off by default**. A selfhosted owner can enable a three-way mode (off /
errors-&-escalations-only / all) behind an explicit consent confirm, refine it
per agent (inherit/always/never — inert while the global mode is off: the
master switch is the consent boundary), and see the state honestly (green
`Metadata-only` ↔ amber `Bodies captured`). Captured bodies are client-wire
(media-stripped, 256 KiB/direction cap with honest truncation), stored
**encrypted** in a separate `request_body` table off the hot path (byte-budgeted
writer queue; a dropped body never touches the request), retained 30 days by
default (infinite only as an explicit "keep forever" choice) with a daily purge
job, per-request delete + purge-all + keep-or-purge on disable — all race-proof
against in-flight writes (owner-locked inserts, epochs, tombstones). The
inspector gains a lazily-fetched Payload section; the request listing exposes
only a `hasBodies` flag. Cloud instances never capture.
