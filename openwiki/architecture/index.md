# Files

- [Architecture Overview](overview.md) - Polyrouter's dual-plane monorepo architecture — control plane (NestJS), data plane (proxy engine), shared types/utilities, frontend (SolidJS), and the optional Layer-2 semantic stack (embedder, classifier, learning loop) — with core invariants and the technology stack.
- [Request Flow](request-flow.md) - The complete lifecycle of an LLM request through polyrouter — from ingress through auth, budget enforcement, Layer 0/1/2/3 routing resolution, protocol translation, provider execution, decision-trail telemetry, cost recording, and (for the L2-ambiguous slice) hot-path learning evidence contribution.
- [Semantic Stack](semantic-stack.md) - The optional Layer-2 semantic stack — local ONNX embedder, v1 model-bundle contract, three-band cosine classifier, per-tenant learned centroids with bounded evidence accumulation, and the L1→L2→L3 decision trail.
