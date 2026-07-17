---
type: Architecture
title: Routing Engine
description: Polyrouter's layered routing engine — Layer 0 explicit routing, Layer 1 structural classification, Layer 3 cascade routing with cheap-first escalation and quality-gated fallbacks.
tags: [routing, tiers, cascade, fallback, auto-routing]
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

### Phase 2: Header Rules

Routing rules match on request headers:

```
x-polyrouter-tier: fast
```

Rules have priority ordering; the first match wins. Rules can also match on custom headers for advanced routing policies.

### Phase 3: Default Rule

If no model field or header rule matches, the system's default routing rule applies.

### Phase 4: Default Tier Fallback

As the final fallback, the default tier's entry chain is used.

**Source**: `packages/data-plane/src/routing/resolve.ts` — `resolveRoute()` function

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

## Layer 3 — Cascade Routing

Cascade routing activates when Layer 1 returns `ambiguous`. It implements a **cheap-first with escalation** strategy:

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
function autoLayerCapability(): { structural: boolean; cascade: boolean } {
  // Returns what this instance can do based on config
}
```

Tenant preferences are combined with instance capabilities:

```typescript
function effectiveAutoLayers(capability, tenantPrefs): AutoLayerSelection {
  // Structural enabled only if both instance and tenant agree
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
