---
'@polyrouter/data-plane': patch
'@polyrouter/control-plane': patch
---

Record the matched value for `x-polyrouter-tier` remap rules (record-tier-header-value).
The routing resolver now records the matched owned rule value for a request routed by
an `x-polyrouter-tier` remap rule (a dashboard Header rule on the tier header) — the
tier-ask category the client sent (e.g. `shopping`) — so the request inspector's DECISION
`header` row renders `x-polyrouter-tier: shopping` instead of the header name alone. The
value flows through the existing `routing_header_value` column and the inspector's
existing `<name>: <value>` rendering; no schema, migration, API, or frontend change. The
recorded value is the OWNED config string that matched (config-side provenance, identical
to the direct-tier lookup's tier key), never arbitrary client bytes — so invariant 8 holds.
Rules on any OTHER header are unchanged: they still record the header name only, because a
configured value on an arbitrary header can be a credential (fail-closed, no denylist).
