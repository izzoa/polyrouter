---
'@polyrouter/data-plane': minor
'@polyrouter/control-plane': minor
---

The Layer-2 semantic-embedder foundation lands as a flag-gated optional
module (add-semantic-embedder). Setting `SEMANTIC_MODEL_PATH` to a local
model bundle (versioned manifest + WordPiece vocab + ONNX weights) activates
a bounded local embedding runtime: warmup at boot, per-embed hard timeout,
input cap, no-queue admission semaphore, content-derived model revision, and
fail-fast boot on a broken bundle (the port never binds). Unset, the module
is absent entirely — the runtime dependency is an optional peer that npm
never auto-installs, the baseline image stays ORT- and model-free
(CI-asserted), and behavior is unchanged. `ROUTING_AUTO_LAYERS` is now a
validated token list (unknown layer names reject boot instead of silently
disabling routing) and accepts an inert `semantic`; the auto-layers API
reports `semanticAvailable`. Embedded text and vectors are never logged or
persisted. Routing does not consume the embedder yet — that arrives with
add-semantic-routing.
