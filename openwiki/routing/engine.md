---
type: Architecture
title: Routing Engine
description: Polyrouter's layered routing engine — Layer 0 explicit routing, Layer 1 structural classification, Layer 2 semantic embedding classification, Layer 3 cascade routing with cheap-first escalation and quality-gated fallbacks.
tags: [routing, tiers, cascade, fallback, auto-routing, semantic, onnx, embedding]
resource: packages/data-plane/src/routing/resolve.ts
---

# Routing Engine

Polyrouter's routing engine is a **layered, degradable pipeline**. Explicit routing is the reliable core that always works. Automatic routing layers are opt-in enhancements that must degrade gracefully when disabled or when they produce ambiguous results.

## Design Philosophy

> Explicit routing is the reliable core; automatic routing is opt-in enhancement that must degrade gracefully.

Every request passes through Layer 0. Layers 1 and 3 activate only when:
1. The instance has the capability enabled (`routing.config.ts`)
2. The tenant has opted in via routing settings
3. The request uses the `auto` model keyword

## Layer 0 — Explicit Routing

Layer 0 is a pure function with no DB, Nest, or clock dependencies. It resolves in four phases:

### Phase 1: Model Field

The `model` field in the request body is parsed for three patterns:

| Pattern | Example | Behavior |
|---------|---------|----------|
| Direct model ID | `gpt-4o` | Find model in any tier, use its primary entry |
| Provider-prefixed | `p1:gpt-4o` | Route to specific provider's model |
| Tier name | `fast` | Use the named tier's entry chain |

### Phase 2: Tier Header (Highest Precedence)

The built-in `x-polyrouter-tier` header has **structural precedence** over all other header rules. A non-empty `x-polyrouter-tier` that resolves to a tier or remap rule wins regardless of other header rules' priority values.

```
x-polyrouter-tier: fast
```

Phase 2 has two sub-steps:
1. **Remap rules** — tier-header rules matching the sent value (dashboard Header rules)
2. **Direct tier lookup** — the sent value naming an owned tier directly

### Phase 3: Other Header Rules

Routing rules on headers *other than* `x-polyrouter-tier` match in priority order. The first match wins. Rules can match on custom headers for advanced routing policies.

**Source**: `packages/data-plane/src/routing/resolve.ts` — Phase 2/3 separation (add-tier-header-precedence)

### Phase 4: Default Rule

If no model field or header rule matches, the system's default routing rule applies.

### Phase 5: Default Tier Fallback

As the final fallback, the default tier's entry chain is used.

**Source**: `packages/data-plane/src/routing/resolve.ts` — `resolveRoute()` function

## Matched Routing Header

When a request is routed by a header (Phase 2 or 3), the `RouteDecision` carries a `matchedHeader` field identifying which header chose the route:

| Scenario | `matchedHeader.name` | `matchedHeader.value` |
|----------|----------------------|----------------------|
| Built-in tier header (`x-polyrouter-tier: fast`) | `x-polyrouter-tier` | `fast` (the owned tier key) |
| Custom header rule (`x-env: prod` → tier `fast`) | `x-env` | `null` (never recorded) |
| Non-header decision (explicit model, default rule, etc.) | `null` | `null` |

The value is recorded only when provably non-secret: the built-in tier header carries the matched owned tier key (already recorded as `tier_assigned`). A custom rule's configured `header_value` can itself be a credential, so only the normalized header name is persisted — never the value. This is fail-closed by design.

The matched header is persisted to `request_log.routing_header_name` / `routing_header_value` and displayed in the dashboard's [Inspector](/openwiki/dashboard/overview.md#requests) when a request row is selected.

**Source**: `packages/data-plane/src/routing/resolve.ts` — `MatchedHeader` interface (add-routing-header-visibility)

## Tiers and Routing Entries

A **tier** is a named routing target (e.g., `default`, `fast`, `cheap`, `auto_low`, `auto_high`). Each tier has an ordered chain of up to 5 **routing entries**:

```typescript
interface RouteEntry {
  providerId: number;
  modelId: number;
  position: number; // 0 = primary, 1-4 = fallbacks
}
```

The entry chain is walked in position order during execution. If the primary (position 0) fails and the error is fallback-eligible, position 1 is tried, and so on.

**Configuration**: Tiers and entries are managed via the dashboard's Routing page or the `/api/tiers` and `/api/routing-entries` endpoints.

## Layer 1 — Structural Classification

Layer 1 classifies request complexity using cheap, language-neutral features. It is **opt-in** and activates only for `auto` model requests.

### Feature Extraction

The structural router extracts features from the normalized request:

- Input message length
- Tool count and parameter complexity
- Vision content presence
- System prompt length
- Response format requirements

### Classification

Features are compared against a learned baseline (exponential moving average of the tenant's historical patterns). The result is one of:

| Band | Meaning | Action |
|------|---------|--------|
| `high` | Complex request | Route to `auto_high` tier |
| `low` | Simple request | Route to `auto_low` tier |
| `ambiguous` | Uncertain | Trigger Layer 3 cascade |

**Source**: `packages/data-plane/src/routing/structural.ts`

## Layer 2 — Semantic Embedding Classification

Layer 2 is an **opt-in** ONNX-based embedding classifier that sits between Layer 1 (structural) and Layer 3 (cascade). It uses cosine similarity against per-band centroids to classify `auto` model requests as `high`, `low`, or `ambiguous` — mirroring Layer 1's three-band contract but with semantic understanding instead of structural heuristics.

### Activation and Degradation

Layer 2 activates only when all of the following hold:
1. `SEMANTIC_MODEL_PATH` is set (pointing to a valid ONNX model bundle)
2. The embedder runtime loaded and warmed successfully during boot
3. The tenant has opted in via routing settings

If any condition fails, Layer 2 degrades to `skip` — it never blocks or stalls a request (invariant 1). An unset `SEMANTIC_MODEL_PATH` means the module is entirely absent (no ONNX import, no capability). An invalid or broken path **fails boot** with a loud error naming the env var — an operator who explicitly opted in never gets a silently-inert layer.

### Embedding Pipeline

The pipeline lives in the data plane (`packages/data-plane/src/semantic/`):

1. **Input extraction** (`extract.ts`) — serializes the normalized request to a single text string, newest-user-turn-first, system prompts excluded. Budget-aware with hard caps. Versioned (`SEMANTIC_EXTRACTOR_VERSION`); any change to this algorithm is a new embedding space.
2. **Embedding** (`embedder.ts`) — the `Embedder` interface resolves a unit-norm `Float32Array` of exactly `dims` entries, or rejects typed (timeout, saturation, invalid output). The control-plane runtime uses ONNX Runtime; tests use a deterministic SHA-256-seeded stub embedder.
3. **Classification** (`classify.ts`) — pure cosine three-band classification over unit-norm centroids. The score is `clamp(cos(v, high)) − clamp(cos(v, low))` ∈ [−2, 2]. Degenerate inputs return a discriminated `invalid` (never a band, never telemetry).

### Bundled Anchors and Centroids

At boot, the classifier service serializes a curated set of anchor prompts (`anchors.ts`) through the same extractor, embeds them, and averages per-band centroids. The anchor set is versioned (`ANCHOR_SET_ID = 'bundled-v1'`) — any edit is a new revision. The classifier validates centroids (unit-norm, non-cancelling) and fails boot on a broken anchor set.

### Learned Centroids (Semantic Learning)

When the tenant enables semantic learning, a scheduled daily sweep folds accumulated evidence into learned per-tenant centroids that **decorate** (not replace) the bundled source:

- **Evidence accumulator** (`evidence-accumulator.ts`) — a bounded, in-process volatile accumulator that collects embeddings from settled cascade outcomes. Only a cohort of ≥ `SEMANTIC_LEARNING_MIN_COHORT` embeddings is ever flushed to Redis; a single embedding is never persisted (privacy invariant).
- **Labeling** (`learning.ts`) — a quality-passed cheap answer is a `low` exemplar; a quality-gate escalation is a `high` exemplar; everything else (provider faults, cancellations, fail-open unknown quality) is discarded as non-evidence.
- **Sweep** (`learning.run.ts`, `learning.scheduler.ts`) — a BullMQ-scheduled daily occurrence (`SEMANTIC_LEARNING_SCHED_CRON`, default `0 3 * * *`) that rotates pending buckets, folds evidence onto centroids via EMA with spherical drift clamping, and promotes the new generation atomically (Postgres CAS + audit first, then Redis promote). Crash-atomic: Postgres is authoritative.
- **Classification source** (`classification-source.ts`, `learned-classification-source.ts`) — a decorator pattern. The `ClassificationSourceProvider` seam returns bundled centroids by default; the learned decorator substitutes per-tenant learned centroids when the decision-time `LearningGate` matches the request's coordinates. Any failure falls back to bundled centroids — never to the router's skip path.

### API Surface

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/routing/semantic-learning/status` | GET | Learning status (enabled, source, epoch, generation, fresh counts, history) |
| `/api/routing/semantic-learning/revert` | POST | Idempotent revert: bumps revocation epoch (Postgres-first), clears Redis |
| `/api/routing/auto-layers` | PUT | Toggle semantic learning via `semanticLearning` field |

### Configuration

| Env Var | Default | Purpose |
|---------|---------|---------|
| `SEMANTIC_MODEL_PATH` | (unset) | Path to ONNX model bundle; unset = module absent |
| `SEMANTIC_TIMEOUT_MS` | 50 | Embed timeout (ms); out-of-bounds fails boot |
| `SEMANTIC_MAX_INPUT_CHARS` | 2000 | Max text fed to embedder |
| `SEMANTIC_CONCURRENCY` | 2 | Max concurrent embeddings |
| `SEMANTIC_HIGH_THRESHOLD` | 0.15 | Cosine threshold for `high` band |
| `SEMANTIC_LOW_THRESHOLD` | 0.15 | Cosine threshold for `low` band |
| `SEMANTIC_LEARNING_MIN_COHORT` | 8 | Min embeddings per label before flush to Redis |
| `SEMANTIC_LEARNING_MIN_SAMPLES` | 50 | Min samples before a sweep can apply |
| `SEMANTIC_LEARNING_ALPHA` | 0.2 | EMA weight for centroid folding |
| `SEMANTIC_LEARNING_MAX_DRIFT` | 0.35 | Max spherical drift per fold |
| `SEMANTIC_LEARNING_COOLDOWN_H` | 24 | Hours between sweeps for a tenant |
| `SEMANTIC_LEARNING_STATE_TTL_D` | 30 | Redis state TTL (days) |
| `SEMANTIC_LEARNING_SCHED_ENABLED` | true | Whether the sweep worker runs |
| `SEMANTIC_LEARNING_SCHED_CRON` | `0 3 * * *` | Sweep schedule |

All numeric values are validated with Zod min/max; out-of-bounds values **fail boot** rather than silently clamping.

### Key Source Files

| File | Role |
|------|------|
| `packages/data-plane/src/semantic/embedder.ts` | `Embedder` interface + stub embedder |
| `packages/data-plane/src/semantic/classify.ts` | Pure cosine three-band classifier |
| `packages/data-plane/src/semantic/extract.ts` | Canonical semantic-input extractor |
| `packages/data-plane/src/semantic/anchors.ts` | Bundled anchor exemplars |
| `packages/data-plane/src/semantic/learning.ts` | Pure learning math (EMA, drift, folding) |
| `packages/control-plane/src/semantic/semantic-runtime.service.ts` | ONNX runtime lifecycle + readiness |
| `packages/control-plane/src/semantic/semantic-classifier.service.ts` | Classifier lifecycle (boot, centroids, provenance) |
| `packages/control-plane/src/semantic/semantic-router.ts` | Layer-2 router (mirrors StructuralRouter) |
| `packages/control-plane/src/semantic/classification-source.ts` | `ClassificationSourceProvider` seam + `LearningGate` |
| `packages/control-plane/src/semantic/learned-classification-source.ts` | Decorator layering learned state over bundled |
| `packages/control-plane/src/semantic/evidence-accumulator.ts` | Bounded volatile in-process accumulator |
| `packages/control-plane/src/semantic/learning-store.ts` | Redis learning store (rotate, stage, promote) |
| `packages/control-plane/src/semantic/learning.run.ts` | One sweep occurrence (per-tenant fold + promote) |
| `packages/control-plane/src/semantic/learning.scheduler.ts` | BullMQ scheduler + reconcile loop |
| `packages/control-plane/src/semantic/semantic-learning.service.ts` | Status + revert API surface |
| `packages/control-plane/src/semantic/semantic-learning.controller.ts` | `/api/routing/semantic-learning` controller |
| `packages/control-plane/src/semantic/bundle.ts` | Model-bundle manifest schema (Zod) |
| `packages/control-plane/src/semantic/onnx-loader.ts` | ONNX Runtime dynamic import + bundle load |
| `packages/control-plane/src/semantic/semantic-learning-contributor.ts` | Recorder hook at cascade-settle (evidence sink) |

## Layer 3 — Cascade Routing

Cascade routing activates when Layer 1 or Layer 2 returns `ambiguous`. It implements a **cheap-first with escalation** strategy:

```
① Try cheap tier (auto_low) with timeout
    │
    ▼
② Evaluate quality score (binary: 0 or 1)
    │
    ├── score ≥ threshold (0.5) → Accept cheap response
    │
    └── score < threshold → ③ Escalate to strong tier (auto_high)
                              │
                              ▼
                         ④ Replay buffered response as stream if accepted
```

### Quality Evaluation

Quality scoring is deliberately simple — binary 0 or 1:

```typescript
function evaluateQuality(response: NormalizedResponse): number {
  if (stopReason === 'error' || stopReason === 'content_filter') return 0;
  if (empty content || malformed tool args) return 0;
  return 1;
}
```

This avoids the complexity of embedding-based quality classifiers while still catching obvious failures.

### Cascade Commit Rule

The cascade follows the same commit boundary as the main proxy: once the first token is sent to the client, the model is locked. However, cascade has an additional pre-commit evaluation window where the cheap response is buffered and evaluated before streaming begins.

**Source**: `packages/control-plane/src/proxy/proxy.service.ts` — cascade orchestration

## Auto-Layer Capability

The routing system reports its capabilities per instance:

```typescript
function autoLayerCapability(): { structural: boolean; semantic: boolean; cascade: boolean } {
  // Returns what this instance can do based on config
}
```

Tenant preferences are combined with instance capabilities:

```typescript
function effectiveAutoLayers(capability, tenantPrefs): AutoLayerSelection {
  // Structural enabled only if both instance and tenant agree
  // Semantic enabled only if structural is enabled AND the ONNX model is loaded
  // Cascade enabled only if structural is enabled and tenant agrees
}
```

**Source**: `packages/control-plane/src/proxy/routing.config.ts`

## Fallback Chain Behavior

When a provider in the entry chain fails:

1. **Classify the error** — `shouldFallback(kind)` determines eligibility
2. **Check commit state** — if already committed to a stream, no fallback
3. **Check circuit breaker** — if the next provider's breaker is open, skip it
4. **Try next entry** — walk the chain until success or exhaustion

Fallback-eligible errors: `auth`, `rate_limit`, `unavailable`, `unknown` (upstream)
Non-fallback errors: `bad_request`, `unknown_model` (routing-level)

**Source**: `packages/data-plane/src/proxy/core.ts` — chain execution logic

## Configuration

Routing configuration is loaded from environment variables and validated with Zod:

```typescript
// packages/control-plane/src/proxy/routing.config.ts
const ROUTING_CONFIG = defineConfig('ROUTING', {
  STRUCTURAL_WEIGHTS: z.string().optional(),
  CASCADE_CHEAP_TIMEOUT_MS: z.coerce.number().default(5000),
  CASCADE_QUALITY_THRESHOLD: z.coerce.number().default(0.5),
  // ...
});
```

Structural weights are validated for semantic correctness (LOW values < HIGH values) and normalized to sum to 1.0.

Semantic routing config (`SEMANTIC_*` env vars) is validated separately in `packages/control-plane/src/semantic/semantic.config.ts`. See the [Layer 2](#layer-2--semantic-embedding-classification) section above for the full table.
