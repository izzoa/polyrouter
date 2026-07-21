---
'@polyrouter/shared': minor
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
'@polyrouter/frontend': patch
---

Layer 2 semantic routing (add-semantic-routing) turns the embedder foundation
into real routing. When a `model:"auto"` request is Layer-1 ambiguous and the
semantic layer is effectively enabled (instance flag + a loaded embedder +
built anchor centroids + tenant preference), polyrouter embeds a versioned,
newest-first serialization of the request and classifies it against bundled
anchor centroids: a confident **high**/**low** band routes through the same
`auto_high`/`auto_low` targets with `decision_layer='semantic'`, while a still-
ambiguous verdict hands to cascade or the default tier exactly as before. Every
Layer-2 fault — not ready, embed timeout, caller disconnect, a degenerate
vector — degrades to that same flow with no delay beyond one bounded embed
attempt and no fabricated telemetry (invariant 1). Four nullable telemetry columns
(`semantic_band`/`semantic_score`/`semantic_source`/`semantic_revision`, an
opaque provenance digest) ride the parent request rows with all-or-none +
score-range DB checks, and the ordered Layer-1→Layer-2 classification trail is
recorded on both the default-fall-through and cascade reasons. The auto-layers
API and settings gain a `semantic` preference (backfilled from the structural
preference, semantic⇒structural enforced, atomic dependency-aware normalization
for older clients); the analytics request listing exposes the four fields
verbatim and its `decision_layer` filter accepts `semantic`. No prompt text or
vectors are ever logged or persisted.
