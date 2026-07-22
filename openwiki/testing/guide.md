---
type: Reference
title: Testing Guide
description: Polyrouter's testing strategy — unit tests, e2e tests, contract tests (golden files), security suites, semantic-stack e2e suites (embedder boot, classifier, learning sweep, revert), CI pipeline, and how to run tests locally.
tags: [testing, jest, vitest, e2e, ci, golden-tests, semantic, layer-2]
resource: .github/workflows/ci.yml
---

# Testing Guide

Polyrouter has comprehensive test coverage across five test types: unit tests, end-to-end tests, contract tests (golden files), security regression suites, and the semantic-stack suites that pin embedder boot, classifier math, learning sweep, and crash-atomicity.

## Test Types

### Unit Tests

| Package | Runner | Pattern | Command |
|---------|--------|---------|---------|
| control-plane | Jest | `*.spec.ts` | `npm run test -w packages/control-plane` |
| data-plane | Jest | `*.spec.ts` | `npm run test -w packages/data-plane` |
| shared | Vitest | `*.test.ts` | `npm run test -w packages/shared` |
| frontend | Vitest | `*.test.tsx`, `*.test.ts` | `npm run test -w packages/frontend` |

The semantic stack adds these unit suites:

- `packages/control-plane/src/semantic/bundle.spec.ts` — manifest Zod parsing, content-derived revision, WordPiece golden vectors, bundle errors
- `packages/control-plane/src/semantic/embed-core.spec.ts` — bounded embed pipeline: deadlines, semaphore, output validation, late settlement
- `packages/control-plane/src/semantic/onnx-integration.spec.ts` — ORT session contract (with a stub ORT loader)
- `packages/control-plane/src/semantic/semantic-router.spec.ts` — Layer-2 evaluation contract: skip/route/ambiguous/unroutable paths, all faults degrade to skip
- `packages/control-plane/src/semantic/semantic-classifier.service.spec.ts` — bundled centroid build, validateCentroids, learned vs bundled revision
- `packages/control-plane/src/semantic/learning-store.spec.ts` — in-memory reference store mirrors the Lua-backed Redis store
- `packages/control-plane/src/semantic/learning-store-redis.spec.ts` — Lua atomicity: rotate / stage / promote / discardStaleRevisions / pendingCounts
- `packages/control-plane/src/semantic/evidence-accumulator.spec.ts` — bounded cohort accumulation, drop-BEFORE-allocation, min-cohort flush floor
- `packages/control-plane/src/semantic/semantic-learning-contributor.spec.ts` — outcome → label mapping, gate-disabled path, evidence drop after contribution
- `packages/control-plane/src/semantic/learning.run.spec.ts` — sweep contract: discard pass, apply pass, cooldown gating, Redis fault → bundled
- `packages/control-plane/src/semantic/learning-revision.spec.ts` — digest stability across input orderings
- `packages/control-plane/src/semantic/classification-source.spec.ts` / `learned-classification-source.spec.ts` — bundled-only and bundled-vs-learned seams
- `packages/data-plane/src/semantic/embedder.spec.ts` — `stubEmbedder` determinism (same text → same vector; distinct texts → distinct vectors; unit norm)
- `packages/data-plane/src/semantic/classify.spec.ts` — three-band cosine math + `invalid` discriminated union
- `packages/data-plane/src/semantic/extract.spec.ts` — canonical text extraction (newest-first, budget-aware, no fabricated non-empty from system-only requests)
- `packages/data-plane/src/semantic/learning.spec.ts` — pure learning math: `labelForOutcome`, `foldEvidence`, `clampDriftSpherical`, `cosineDistance`, `evidenceMean`, `foldBothLabels`
- `packages/frontend/src/data/semanticLearning.test.ts` — view-model rules for the L2 learning card (no fabricated "learned" badge when stale)

### End-to-End Tests

E2E tests run against real PostgreSQL and Redis instances using Supertest:

```
packages/control-plane/test/
├── proxy/
│   ├── cascade-routing.e2e-spec.ts        # Cascade routing with real providers
│   ├── stream-lifecycle.e2e-spec.ts       # Stream commit boundary
│   ├── structural-routing.e2e-spec.ts     # Layer-1 thresholds, baseline, telemetry
│   ├── semantic-routing.e2e-spec.ts       # L1→L2 trail, semantic decision layer, telemetry quartet
│   ├── long-call-timeouts.e2e-spec.ts     # Per-provider TTFT/idle overrides + breaker
│   ├── stub-upstream.ts                   # Mock upstream server
│   └── inference-proxy.e2e-spec.ts        # ...
├── routing/
│   ├── auto-layers.e2e-spec.ts            # structural / cascade / semantic gating
│   └── semantic-learning.e2e-spec.ts      # L2 sweep, evidence accumulation, revert
├── analytics/
│   └── analytics.e2e-spec.ts              # Analytics + L2 filter + semantic_source breakdown
├── providers/
│   ├── provider-management.e2e-spec.ts
│   └── model-pricing.e2e-spec.ts          # Listed-price display vs billing price invariants
├── subscription-oauth/
│   └── oauth-connect.e2e-spec.ts          # Connect/complete/reauthorize flow with stubbed IdP
├── auth/
│   ├── auth.e2e-spec.ts                   # Session auth, rate limits
│   └── user-admin.e2e-spec.ts             # First-signup-wins, invites, admin disable
├── notifications/
│   └── notification-channels.e2e-spec.ts
├── producers/
│   └── notification-producers.e2e-spec.ts
├── budgets/
│   └── budget-enforcement.e2e-spec.ts
├── body-capture/
│   └── body-capture.e2e-spec.ts           # Body capture opt-in, purge, tombstone
├── pricing/
│   └── pricing-catalog.e2e-spec.ts        # Catalog refresh, status endpoint
├── semantic-boot.e2e-spec.ts              # ORT boot, classifier readiness, telemetry
└── observability/
    ├── metrics.e2e-spec.ts
    └── tracing.e2e-spec.ts
```

#### Semantic E2E Coverage

`semantic-routing.e2e-spec.ts` exercises:

- An `auto` request with a confidently-band L2 vector routes with `decision_layer='semantic'`
- An L1-ambiguous request with an L2-confident vector bypasses cascade entirely
- An L2-ambiguous vector hands to cascade (or default, when cascade is off)
- A degenerate/invalid L2 vector (zero norm, dims mismatch) degrades to `skip` — never a fabricated band
- The full ordered L1→L2 reasoning trail appears in `routing_reason`
- Semantic telemetry quartet (band/score/source/revision) is all-or-none on the DB

`semantic-learning.e2e-spec.ts` exercises:

- A tenant with learning off generates no audit events (default-OFF invariant)
- An L2-ambiguous request whose cascade settled quality-passed contributes a `low` sample
- An L2-ambiguous request whose cascade escalated on the quality gate contributes a `high` sample
- An L2-ambiguous request whose cascade cheap-error escalated contributes nothing (no `cheap_error` label)
- A cohort below `MIN_COHORT` does not flush to Redis
- A sweep with insufficient samples skips the tenant without rotating
- A sweep with sufficient samples promotes generation N+1; the next read serves `source='learned'`
- A revert bumps the epoch; subsequent reads fall back to bundled; the audit row records `trigger='revert'`
- A concurrent revert during an in-flight sweep fails the CAS and no promote happens (crash-atomicity)

### Contract Tests (Golden Files)

Protocol translation is verified with recorded wire-format fixtures:

```
packages/data-plane/src/proxy/translate/golden/
├── anthropic/    # Anthropic wire format examples
├── openai/       # OpenAI wire format examples
└── README.md     # Test documentation
```

Tests verify round-trip fidelity: `requestIn(requestOut(ir))` must preserve semantics. Streaming and non-streaming variants are both covered, including tool use, system prompt order, cache control, and reasoning blocks.

The semantic text extractor has its own golden suite inside `extract.spec.ts` — pinned exact-string outputs that would shift if any of the truncation, ordering, or content-block-rendering rules changed.

### Security Regression Suites

| Suite | File | What It Tests |
|-------|------|---------------|
| SSRF | `packages/shared/test/ssrf.test.ts` | Private IP blocking, DNS rebinding defense |
| Encryption | `packages/shared/test/encryption.test.ts` | AES-256-GCM encrypt/decrypt, key rotation |
| Credential envelope | `packages/shared/test/credential-envelope.test.ts` | Typed `polycred:v1:` parse, tamper detection, oauth-kind unforgeability |
| Network host | `packages/shared/test/network-host.test.ts` | IP classification (private, loopback, link-local) |
| Tenant isolation | (e2e tests) | Cross-tenant read prevention |
| Cost immutability | (e2e tests) | Price snapshots never recomputed |

The semantic stack adds:

- `learning-store-redis.spec.ts` — pinned rotation against `decide-after-write` races (Lua atomicity)
- `learning.run.spec.ts` — discard pass: deletes stale-revision pending + active WITHOUT bumping generation; apply pass: bumps generation only on a CAS success
- `learned-classification-source.spec.ts` — Redis fault, deadline expiry, invalid vector, and stale-revision state all fall back to bundled (never `skip`)
- `semantic-router.spec.ts` — every fault path (timeout, abort, embedder saturation, degenerate vector) degrades to `skip`

### Frontend Regression Suites

| Suite | File | What It Tests |
|-------|------|---------------|
| Contrast | `styles.contrast.test.ts` | WCAG AA contrast ratios |
| Elevation | `styles.elevation.test.ts` | Flat-borders adherence |
| Motion | `styles.motion.test.ts` | Prefers-reduced-motion support |
| Keyboard a11y | `a11y.test.tsx` | Keyboard operability, focus management |
| Coherence | `coherence.test.tsx` | Design system coherence |
| Auto-perf view-model | `autoPerf.test.ts` | L2 slice math (residual-cascade labeling) |
| Band targets | `bandTargets.test.ts` | `auto_high` / `auto_low` VM and degraded states |
| Routing grouping | `Routing.grouping.test.ts` | Drag-to-reorder chain math |
| L2 learning VM | `semanticLearning.test.ts` | `staleReason`, `showRevert`, `samplesLine` |

## Running Tests

### All Tests

```bash
npm run test
```

### Specific Package

```bash
npm run test -w packages/control-plane
npm run test -w packages/data-plane
npm run test -w packages/shared
npm run test -w packages/frontend
```

### With Coverage

```bash
npm run test:coverage
```

### Watch Mode

```bash
npm run test:watch -w packages/control-plane
```

### E2E Tests (Requires Infrastructure)

E2E tests need PostgreSQL and Redis running:

```bash
docker compose -f docker-compose.dev.yml up -d postgres redis
npm run test:e2e -w packages/control-plane
```

### Semantic E2E Tests in Isolation

```bash
npm run test:e2e -w packages/control-plane -- --testPathPattern="semantic"
```

The semantic tests use the **`stubEmbedder`** (SHA-256-seeded deterministic unit-norm vectors) by default — no ONNX runtime required. The boot test (`semantic-boot.e2e-spec.ts`) is the integration test that exercises the real ORT path through a child process; it tolerates `onnxruntime-node` device-discovery stderr noise but otherwise expects a working native module.

## CI Pipeline

The GitHub Actions CI pipeline (`.github/workflows/ci.yml`) runs on every push:

```
Push/PR
    │
    ▼
┌─────────────────────────────┐
│ Build (all packages)        │
│ Lint (ESLint + Prettier)    │
│ Typecheck (tsc --noEmit)    │
│ Unit Tests (Jest + Vitest)  │
└─────────────┬───────────────┘
              │
              ▼
┌─────────────────────────────┐
│ E2E Tests (real Postgres)   │
│ Security Suites             │
│ Install Script Tests        │
│ ORT Boot Integration        │
└─────────────────────────────┘
```

### Additional CI Checks

- **Breaker parity** — Redis-gated circuit breaker tests
- **Install re-run idempotency** — `test/install-rerun.test.sh`
- **StyleSeed score** — frontend must score ≥ 80 on design lock
- **Baseline image is ORT- and model-free** — CI asserts the baseline `runtime` Dockerfile target has zero ONNX artifacts (no regression of the semantic stack into the baseline)
- **Semantic Better-Auth ESM isolation** — the Better-Auth e2e suites run in their own Jest process to avoid ESM/CJS realm collisions with the semantic boot integration

## Testing Patterns

### Mock Providers

E2E tests use a stub upstream server (`stub-upstream.ts`) that simulates provider behavior:

- Configurable response delays
- Error injection (rate limit, auth failure, unavailable)
- Stream simulation
- Usage token reporting

The semantic routing e2e suites inject a `stubEmbedder` via the `SemanticModule`'s `SEMANTIC_LOADER` token, so the same suite runs deterministically against fixed vectors regardless of the model present on disk.

### Budget Testing

Budget tests use Redis test fixtures with controlled time advancement:

```typescript
// Set spend counter
await redis.set(`budget:${owner}:global:day:${period}`, 900_000);

// Request that exceeds budget
const res = await request(app).post('/v1/chat/completions')...;
expect(res.status).toBe(429);
```

### Cascade Testing

Cascade tests verify the full cheap→strong escalation path with quality evaluation:

```typescript
// Configure cheap tier to return low-quality response
stubUpstream.setResponse('cheap-model', { content: '', stopReason: 'error' });

// Verify escalation to strong tier
const res = await proxyService.handle(request);
expect(res.attempts).toHaveLength(2);
expect(res.attempts[0].outcome).toBe('superseded');
expect(res.attempts[1].outcome).toBe('accepted');
```

### Semantic Learning Testing

```typescript
// Spin up an in-memory learning store (mirrors the Lua-backed Redis store)
const store = new InMemoryLearningStore();

// Inject a deterministic embedder
runtime.setEmbedder(stubEmbedder(384));

// Run a sweep with synthetic evidence
await runSemanticLearningOccurrence(db, store, provenance, loadSnapshot, cfg, 0.5, tenantHmac, now);

// Verify the audit row + active state
const events = await db.semanticLearningEvent.list(principal);
expect(events).toHaveLength(1);
expect(events[0].trigger).toBe('apply');
expect(events[0].high_samples).toBeGreaterThanOrEqual(MIN_SAMPLES);
```

## Adding New Tests

### Unit Test Checklist

- [ ] Test the happy path
- [ ] Test error conditions
- [ ] Test boundary values
- [ ] Mock external dependencies (Redis, HTTP)
- [ ] Verify metric emissions
- [ ] For semantic features: verify every fault path degrades to `skip`/`bundled`, never a fabricated success

### E2E Test Checklist

- [ ] Use real PostgreSQL and Redis
- [ ] Clean up test data in `afterEach`
- [ ] Test tenant isolation (cross-tenant reads)
- [ ] Test the full request pipeline
- [ ] Verify database state changes
- [ ] For L2 tests: also assert that an L2 fault does NOT cause the request to fail or stall (invariant 1)

### Golden File Test Checklist

- [ ] Record wire format from real provider (or realistic fixture)
- [ ] Verify IR fidelity after round-trip
- [ ] Cover streaming and non-streaming variants
- [ ] Cover tool use scenarios
- [ ] Cover error responses

### Semantic Test Checklist

- [ ] Never assert telemetry rows for `skip` verdicts (invariant 1)
- [ ] Test the crash-atomicity path: bump the epoch mid-sweep and verify the CAS fails
- [ ] Test the bounded cohort: a count below `MIN_COHORT` never reaches Redis
- [ ] Test the rail validations: out-of-range config rejects boot in `buildSemanticConfig`
- [ ] Verify the L1→L2 trail ordering in `routing_reason`