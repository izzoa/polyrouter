---
type: Architecture
title: Routing Engine
description: Polyrouter's layered routing engine — Layer 0 explicit routing, Layer 1 structural classification, Layer 2 semantic classification (opt-in, refines only the L1-ambiguous slice), and Layer 3 cascade routing with cheap-first escalation and quality-gated fallbacks.
tags: [routing, tiers, cascade, fallback, auto-routing, semantic, layer-2]
resource: packages/data-plane/src/routing/resolve.ts
---

# Routing Engine

Polyrouter's routing engine is a **layered, degradable pipeline**. Explicit routing is the reliable core that always works. Automatic routing layers are opt-in enhancements that must degrade gracefully when disabled, when they produce ambiguous results, or when they fault.

```
                    Layer 0  (always on, never faults)
                         │
                         ▼
                  ┌──────────────┐
                  │  explicit    │── model name  ──────────► ROUTE
                  │  decision?   │── tier header ──────────► ROUTE
                  │              │── header rule ──────────► ROUTE
                  │              │── default ──────────────► CONTINUE
                  └──────┬───────┘
                         │ "auto" + default
                         ▼
                  ┌──────────────┐
                  │  Layer 1     │── high band ─────────────► ROUTE (decision_layer=structural)
                  │  structural  │── low band  ─────────────► ROUTE (decision_layer=structural)
                  │              │── ambiguous ─────────────► continue
                  └──────┬───────┘
                         │ (only when L1=ambiguous)
                         ▼
                  ┌──────────────┐
                  │  Layer 2     │── high band ─────────────► ROUTE (decision_layer=semantic)
                  │  semantic    │── low band  ─────────────► ROUTE (decision_layer=semantic)
                  │  (opt-in)    │── ambiguous ─────────────► continue
                  │              │── skip / fault ──────────► continue
                  └──────┬───────┘
                         │ (only when L1=ambiguous AND L2=ambiguous|skip|unroutable)
                         ▼
                  ┌──────────────┐
                  │  Layer 3     │── cheap quality pass ────► REPLAY BUFFERED
                  │  cascade     │── cheap quality fail ────► ESCALATE
                  │  (opt-in)    │── cheap provider fault ──► ESCALATE (no quality label)
                  └──────┬───────┘
                         │ on escalate
                         ▼
                  strong tier (auto_high) ─► fallback ─► default tier
```

Every smart-layer fault degrades to exactly the same path it would have taken with that layer disabled. The smart path never fails or stalls a request.

## Design Philosophy

> Explicit routing is the reliable core; automatic routing is opt-in enhancement that must degrade gracefully.

Every request passes through Layer 0. Layers 1, 2, and 3 activate only when all of:

1. The instance has the layer enabled (`routing.config.ts`)
2. For Layer 2 specifically, the WHOLE classifier is ready (embedder loaded + bundled centroids built + validated) — capability honestly reports `semanticAvailable` so the dashboard can never show a dead control
3. The tenant has opted in via routing settings (default-on when unset, except `semanticLearning` which defaults OFF for privacy)
4. The request uses the `model: "auto"` alias AND Layer 0 fell through to the default tier

## Layer 0 — Explicit Routing

Layer 0 is a pure function with no DB, Nest, or clock dependencies (`packages/data-plane/src/routing/resolve.ts`). It resolves in five phases, first match wins.

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

### Phase 4: Default Rule

If no model field or header rule matches, the system's default routing rule applies.

### Phase 5: Default Tier Fallback

As the final fallback, the default tier's entry chain is used.

## Matched Routing Header

When a request is routed by a header (Phase 2 or 3), the `RouteDecision` carries a `matchedHeader` field identifying which header chose the route:

| Scenario | `matchedHeader.name` | `matchedHeader.value` |
|----------|----------------------|----------------------|
| Built-in tier header (`x-polyrouter-tier: fast`) | `x-polyrouter-tier` | `fast` (the owned tier key) |
| Custom header rule (`x-env: prod` → tier `fast`) | `x-env` | `null` (never recorded) |
| Non-header decision (explicit model, default rule, etc.) | `null` | `null` |

The value is recorded only when provably non-secret: the built-in tier header carries the matched owned tier key (already recorded as `tier_assigned`). A custom rule's configured `header_value` can itself be a credential, so only the normalized header name is persisted — never the value. This is fail-closed by design.

The matched header is persisted to `request_log.routing_header_name` / `routing_header_value` and displayed in the dashboard's [Inspector](/openwiki/dashboard/overview.md) when a request row is selected.

## Tiers and Routing Entries

A **tier** is a named routing target (e.g., `default`, `fast`, `cheap`, `auto_low`, `auto_high`). Each tier has an ordered chain of up to 5 **routing entries**:

```typescript
interface RouteEntry {
  providerId: number;
  modelId: number;
  position: number; // 0 = primary, 1-4 = fallbacks
}
```

The entry chain is walked in position order during execution. If the primary (position 0) fails and the error is fallback-eligible, position 1 is tried, and so on. Tiers and entries are managed via the dashboard's Routing page or the `/api/tiers` and `/api/routing-entries` endpoints.

## Layer 1 — Structural Classification

Layer 1 classifies request complexity using cheap, language-neutral features. It is **opt-in** and activates only for `auto` model requests that fell through Layer 0 to the default tier.

### Feature Extraction

The structural router extracts features from the normalized request:

- Input message length
- Tool count and parameter complexity
- Vision content presence
- System prompt length
- Response format requirements
- Declared reasoning effort (maximal declaration routes `auto_high` directly)

Per-agent baselines (exponential moving average of the tenant's historical patterns) are subtracted so a huge harness boilerplate prompt can't force everything into the top tier.

### Classification

Features are scored against per-tenant **calibrated thresholds** (resolved from the same settings read as the layer gates — no extra hot-path I/O; degrade-shaped so a stale or rail-violating stored pair reads as nulls). The result is one of:

| Band | Meaning | Action |
|------|---------|--------|
| `high` | Complex request | Route to `auto_high`; `decision_layer='structural'` |
| `low` | Simple request | Route to `auto_low`; `decision_layer='structural'` |
| `ambiguous` | Uncertain | Hand to Layer 2 (then Layer 3 if still ambiguous) |

Telemetry is recorded for every evaluated row (`structural_band`/`structural_score`/`structural_dimension`/`structural_reason`), even when the row falls through to cascade — no silent telemetry.

## Layer 2 — Semantic Classification

Layer 2 refines **only** the L1-ambiguous slice. It never re-evaluates a confident L1 band, and never runs on a non-`auto` model. Layer 2 is **opt-in** (the `semantic` token in `ROUTING_AUTO_LAYERS` ∧ a valid model bundle) and **opt-in per-tenant** (the `semanticEnabled` field on `routing_settings`, default-on when unset). It activates only when `semanticAvailable === true` — the WHOLE classifier ready, not merely the flag.

### How It Works

1. **Extract** request text through the canonical `extractSemanticInput` extractor — newest user turn first, bounded by `totalChars`/`perMessage`/`perBlock` caps; system content excluded; a request with no non-system evidence renders to `''` and the router skips.
2. **Embed** the text under a per-call deadline (`SEMANTIC_TIMEOUT_MS`); the embedder has bounded concurrency (`SEMANTIC_CONCURRENCY`); saturation → `EmbedError('saturated')` → skip.
3. **Resolve classification source** — bundled centroids decorated with per-tenant learned state under read-time gates. Any failure, Redis fault, or stale state → fall back to bundled, never skip.
4. **Classify** — `classifySemantic(vector, centroids, {high, low})` returns `{ kind: 'band' | 'invalid' }`. `invalid` (zero-norm, dim mismatch, non-finite) is a discriminated fault — no band, no telemetry.
5. **Decide** based on band × target:

| Outcome | Verdict carried? | Action |
|---------|------------------|--------|
| `high` band, target resolves | yes | Route to `auto_high`, `decision_layer = 'semantic'`; never cascades |
| `low` band, target resolves | yes | Route to `auto_low`, `decision_layer = 'semantic'`; never cascades |
| Confident band but target empty/missing | yes | Verdict recorded; falls through to Layer 0 default (does **not** cascade — mirrors L1's unroutable) |
| `ambiguous` band | yes | Hand to Layer 3 cascade; **carries the in-memory vector + decision-time learning gate to the recorder** for evidence contribution at cascade-settle |
| `invalid` / fault / unavailable | no | Hand to cascade (or Layer 0 default) |

The full design, bundle contract, classifier, learning loop, and telemetry are documented in the dedicated [Semantic Stack](/openwiki/architecture/semantic-stack.md) reference.

### Layer-2 Invariants

- **Fail open always** — any fault (not ready, embed timeout, caller cancellation, `invalid` classification, Redis fault on learned reads, missing state) yields `skip`. The smart path never fails or stalls a request.
- **Never fabricate telemetry** — a fault returns `{ kind: 'skip' }`, which carries no verdict, no telemetry columns, no row in `request_log.semantic_*`. A non-evaluated row reads as nulls.
- **Privacy** — embedded text and vectors are never logged, persisted to Postgres, returned in an API response, or attached to telemetry. The first value that lands in Redis is a sum of ≥ `MIN_COHORT` embeddings.

## Layer 3 — Cascade Routing

Cascade routing activates when Layer 1 returns `ambiguous` AND Layer 2 was also `ambiguous`/`skip`/unroutable. It implements a **cheap-first with escalation** strategy:

```
① Try cheap tier (auto_low) with timeout
    │
    ▼
② Evaluate quality score (binary: 0 or 1)
    │
    ├── score ≥ threshold (default 0.5) → Accept cheap response (replay buffered)
    │
    └── score < threshold → ③ Escalate to strong tier (auto_high)
                              │
                              ▼
                         ④ Strong tier chain → fallback → default tier
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

### L2 Learning-Evidence Contribution

When the cascade settles, the recorder hands the in-memory vector + decision-time learning gate (carried from `SemanticRouter` for the L2-ambiguous slice only) to the `LearningContributionModule`. The contributor resolves a label by outcome:

| Cascade outcome | Label | Evidence contributed |
|-----------------|-------|----------------------|
| Not escalated, `success`/`fallback` with a decided quality signal | `low` | yes |
| Escalated by `quality_gate` | `high` | yes |
| Escalated by `cheap_error` (provider fault) | — | no |
| Cancelled, fail-open unknown quality | — | no |

The vector is dropped after contribution. It never reaches a telemetry column, a writer draft, a log line, or an API response. Only the sum of ≥ `MIN_COHORT` embeddings ever reaches Redis.

## Decision Trail (Ordered)

The `request_log.routing_reason` column carries the ordered L1 → L2 → L3 classification trail. It is APPENDED, never overwritten. Examples:

| Scenario | `decision_layer` | `routing_reason` |
|----------|------------------|------------------|
| Explicit model | `'model'` (or `'header'`/`'rule'`/`'default'`) | `model=gpt-4o` |
| Tier header | `'header'` | `x-polyrouter-tier=fast` |
| L1 confident | `'structural'` | `structural:high s=0.62 hi=0.51 lo=-0.11` |
| L2 confident | `'semantic'` | `structural:ambiguous s=-0.02 hi=0.41 lo=0.43` then `semantic:low s=-0.18 hi=0.30 lo=0.49 src=bundled` |
| Cascade escalation | `'cascade'` | structural → semantic → cascade reason trail |
| Cascade no-op | (downstream layer) | (downstream reason) |

`semantic_band`/`semantic_score`/`semantic_source`/`semantic_revision` are written on every evaluated row (all-or-none DB check); only the confident-band rows also set `decision_layer='semantic'`.

## Auto-Layer Capability

The routing system reports its capabilities per instance:

```typescript
function autoLayerCapability(
  cfg: RoutingConfig,
  semanticClassifierReady = false,
): { structural: boolean; cascade: boolean; semantic: boolean } {
  return {
    structural: cfg.autoLayers.has('structural'),
    cascade: cfg.cascade.enabled,
    semantic: cfg.autoLayers.has('semantic') && semanticClassifierReady,
  };
}
```

Tenant preferences are combined with instance capabilities:

```typescript
function effectiveAutoLayers(
  cap: { structural; cascade; semantic },
  pref: { structuralEnabled; cascadeEnabled; semanticEnabled? } | null,
): { structural; cascade; semantic } {
  return {
    semantic: cap.semantic && (pref?.semanticEnabled ?? true),
    structural: cap.structural && (pref?.structuralEnabled ?? true),
    cascade: cap.cascade && (pref?.cascadeEnabled ?? true),
  };
}
```

`structural` is implied by `cascade` and by `semantic` (boot normalizes both directions; the upsert normalizes down too). The capability + preference formula is shared by `AutoLayersService` and the proxy's per-request read so the two can never drift.

The `/api/routing/auto-layers` endpoint reports `semanticAvailable` honestly:

- `false` because the bundle path is unset → dashboard reads "Off instance-wide (set `SEMANTIC_MODEL_PATH`)"
- `false` because the bundle is broken → "Layer 2 unavailable (bundle invalid)"
- `true` and `semantic = false` because the tenant opted out → tenant-visible toggle, off

The L2 toggle in the dashboard is bound to this — a dead control is impossible by construction.

## Fallback Chain Behavior

When a provider in the entry chain fails:

1. **Classify the error** — `shouldFallback(kind)` determines eligibility
2. **Check commit state** — if already committed to a stream, no fallback
3. **Check circuit breaker** — if the next provider's breaker is open, skip it
4. **Try next entry** — walk the chain until success or exhaustion

Fallback-eligible errors: `auth`, `rate_limit`, `unavailable`, `unknown` (upstream)
Non-fallback errors: `bad_request`, `unknown_model` (routing-level), `provider_credential_required` (config-driven)

## Configuration

Routing configuration is loaded from environment variables and validated with Zod. Out-of-bounds values reject boot (never silently clamped).

```typescript
// packages/control-plane/src/proxy/routing.config.ts
const ROUTING_CONFIG = registerConfig('routing', z.object({
  ROUTING_AUTO_LAYERS: z.string().default('structural'),
  ROUTING_STRUCTURAL_HIGH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  ROUTING_STRUCTURAL_LOW_THRESHOLD: z.coerce.number().min(0).max(1).default(0.25),
  ROUTING_STRUCTURAL_BASELINE_ALPHA: z.coerce.number().gt(0).max(1).default(0.2),
  ROUTING_STRUCTURAL_WEIGHTS: z.string().optional(),
  ROUTING_CASCADE_QUALITY_THRESHOLD: z.coerce.number().gt(0).max(1).default(0.5),
  ROUTING_CASCADE_CHEAP_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
}));
```

Cross-field validation runs in the loader:

- `LOW < HIGH` (otherwise the bands collapse)
- Both thresholds ≤ 4 decimal places
- `AUTO_LAYERS` tokens validated against `{ structural, cascade, semantic }` — unknown tokens reject boot naming the offender
- `cascade` and `semantic` both imply `structural`
- Layer 2 thresholds (in `semantic.config.ts`): ≤ 4 decimals; out-of-range rejects boot

### Per-Tenant Calibration

Per-tenant calibrated thresholds are stored on the `routing_settings` row (`calibratedHigh`, `calibratedLow`, plus anchor columns). A daily BullMQ sweep runs the calibration on opt-in tenants (`CALIBRATION_SCHED_ENABLED=true` by default, cron `0 4 * * *`). The effective per-request formula (`effectiveThresholds`) is pure and degrade-shaped — a calibrated pair applies ONLY when complete, finite, ordered, anchored to the current instance defaults (exact float equality), and clean under the current rails (contraction direction, drift cap, minimum gap). Anything else → the instance defaults; a poisoned or stale row can never fail or stall routing. One-click revert (USER-WINS) bumps the calibrated pair back to the instance defaults.

## Source Map

| Component | Primary file |
|-----------|--------------|
| Layer 0 resolver (pure) | `packages/data-plane/src/routing/resolve.ts` |
| Routing config + capability | `packages/control-plane/src/proxy/routing.config.ts` |
| Routing snapshot loader | `packages/control-plane/src/proxy/routing-snapshot.ts` |
| Proxy orchestration (L1→L2→cascade) | `packages/control-plane/src/proxy/proxy.service.ts` |
| Structural router | `packages/control-plane/src/proxy/structural/structural-router.ts` |
| Cascade router | `packages/control-plane/src/proxy/cascade/cascade-router.ts` |
| Semantic router (Layer 2 verdict) | `packages/control-plane/src/semantic/semantic-router.ts` |
| Cascade plan | `packages/control-plane/src/proxy/cascade/cascade-router.ts` |
| Auto-layers DTO + service | `packages/control-plane/src/routing-config/auto-layers.{dto,service}.ts` |
| Calibration | `packages/control-plane/src/calibration/` |
| Decision-trail recorder | `packages/control-plane/src/recording/request-recorder.ts` |

See [Request Flow](/openwiki/architecture/request-flow.md) for the full lifecycle, [Semantic Stack](/openwiki/architecture/semantic-stack.md) for the deep L2 reference, and [Provider Adapters](/openwiki/providers/adapters.md) for how adapters execute the resolved chain.