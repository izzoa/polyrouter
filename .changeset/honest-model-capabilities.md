---
'@polyrouter/control-plane': minor
'@polyrouter/frontend': minor
---

Describe model capabilities honestly, and let them order a chain

`GET /v1/models` advertised `supports_tools: false`, `supports_vision: false`, and
`supports_reasoning: false` for **every model**, and never emitted
`context_window`. The columns it read had no writer anywhere in the codebase, so
every read returned the column default as though it were an answer. The same dead
columns made `GET /api/models?supportsTools=true` return an empty list for every
tenant.

**Changed — the capability flags are corrected, not extended.** Each flag is now
`true`, `false`, or **absent**, where absent means no source has stated it. A
rendered `false` asserts that a model is known to lack a capability, which is a
different and stronger claim than having no information. Clients reading the
previous universally-`false` value will see flags appear, disappear, and turn
true. The catalog's capability flags became nullable to make this expressible, and
the bundled catalog was re-derived so an existing instance picks up the correction
on boot.

**Changed — the model row no longer carries capability columns.** `context_window`
and the three `supports_*` columns were dropped from `model`; capability resolves
from the global pricing catalog, which is where the archived provider contracts
always placed it. Reverting an image past this release requires re-adding those
four columns first; they only ever held their defaults, so nothing is lost.

**Added — `context_window` and `capabilities_estimated` on `/v1/models`.**
Capability resolves through a ladder — the exact catalog key, then the aggregator
native-family row, then the provider's own claim — and anything resolved below the
exact key is marked as an estimate.

**Added — provider-listed capability claims.** `sync-models` now captures what an
aggregator's own `/models` response states about its models, under the same
freshness and endpoint-change rules the listed price already follows. It is
display-grade evidence, never catalog truth and never routing evidence.

**Added — capability-aware chain ordering.** A chain member the catalog states
cannot serve a request (an image to a model known to accept none, tools to a model
known to support none) is deferred to the end of the walk rather than dropped.
Unknown never defers, a client-named model is never reordered, and where a request
demands no capability the plan is byte-identical to the previous output-cap plan.
