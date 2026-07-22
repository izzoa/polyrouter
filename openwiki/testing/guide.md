---
type: Reference
title: Testing Guide
description: Polyrouter's testing strategy — unit tests, e2e tests, contract tests, security suites, golden-file protocol tests, CI pipeline, and how to run tests locally.
tags: [testing, jest, vitest, e2e, ci, golden-tests]
resource: .github/workflows/ci.yml
---

# Testing Guide

Polyrouter has comprehensive test coverage across four test types: unit tests, end-to-end tests, contract tests (golden files), and security regression suites.

## Test Types

### Unit Tests

| Package | Runner | Pattern | Command |
|---------|--------|---------|---------|
| control-plane | Jest | `*.spec.ts` | `npm run test -w packages/control-plane` |
| data-plane | Jest | `*.spec.ts` | `npm run test -w packages/data-plane` |
| shared | Vitest | `*.test.ts` | `npm run test -w packages/shared` |
| frontend | Vitest | `*.test.tsx`, `*.test.ts` | `npm run test -w packages/frontend` |

### End-to-End Tests

E2E tests run against real PostgreSQL and Redis instances using Supertest:

```
packages/control-plane/test/
├── proxy/
│   ├── cascade-routing.e2e-spec.ts    # Cascade routing with real providers
│   ├── stream-lifecycle.e2e-spec.ts   # Stream commit boundary
│   ├── semantic-routing.e2e-spec.ts   # Layer-2 semantic routing end-to-end
│   └── stub-upstream.ts               # Mock upstream server
├── providers/
│   ├── provider-management.e2e-spec.ts
│   └── model-pricing.e2e-spec.ts      # Listed-price display vs billing price invariants
├── subscription-oauth/
│   └── oauth-connect.e2e-spec.ts      # Connect/complete/reauthorize flow with stubbed IdP
├── auth/
│   ├── auth.e2e-spec.ts               # Session auth, rate limits
│   └── user-admin.e2e-spec.ts         # First-signup-wins, invites, admin disable
├── routing/
│   ├── routing-config.e2e-spec.ts
│   ├── semantic-learning.e2e-spec.ts    # Semantic learning sweep, revert, status
│   └── calibration.e2e-spec.ts          # Calibration scheduling
├── notifications/
│   └── notification-channels.e2e-spec.ts
├── producers/
│   └── notification-producers.e2e-spec.ts
├── budgets/
│   └── budget-enforcement.e2e-spec.ts
├── body-capture/
│   └── body-capture.e2e-spec.ts         # Body capture opt-in, purge, tombstone
├── semantic-boot.e2e-spec.ts            # Semantic ONNX boot matrix (unset, broken, valid paths)
└── pricing/
    └── pricing-catalog.e2e-spec.ts      # Catalog refresh, status endpoint
```

### Contract Tests (Golden Files)

Protocol translation is verified with recorded wire-format fixtures:

```
packages/data-plane/src/proxy/translate/golden/
├── anthropic/    # Anthropic wire format recordings
├── openai/       # OpenAI wire format recordings
└── README.md     # Test documentation
```

Tests verify round-trip fidelity: converting from one protocol to IR and back to the original protocol must preserve semantics.

**Source**: `packages/data-plane/src/proxy/translate/stream.spec.ts`

### Security Regression Suites

| Suite | File | What It Tests |
|-------|------|---------------|
| SSRF | `packages/shared/test/ssrf.test.ts` | Private IP blocking, DNS rebinding defense |
| Encryption | `packages/shared/test/encryption.test.ts` | AES-256-GCM encrypt/decrypt, key rotation |
| Credential envelope | `packages/shared/test/credential-envelope.test.ts` | Typed `polycred:v1:` parse, tamper detection, oauth-kind unforgeability |
| Network host | `packages/shared/test/network-host.test.ts` | IP classification (private, loopback, link-local) |
| Tenant isolation | (e2e tests) | Cross-tenant read prevention |
| Cost immutability | (e2e tests) | Price snapshots never recomputed |

### Frontend Regression Suites

| Suite | File | What It Tests |
|-------|------|---------------|
| Contrast | `styles.contrast.test.ts` | WCAG AA contrast ratios |
| Elevation | `styles.elevation.test.ts` | Flat-borders adherence |
| Motion | `styles.motion.test.ts` | Prefers-reduced-motion support |
| Keyboard a11y | `a11y.test.tsx` | Keyboard operability, focus management |
| Coherence | `coherence.test.tsx` | Design system coherence |

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
docker compose up -d postgres redis
npm run test:e2e -w packages/control-plane
```

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
└─────────────────────────────┘
```

### Additional CI Checks

- **Breaker parity** — Redis-gated circuit breaker tests
- **Install re-run idempotency** — `test/install-rerun.test.sh`
- **StyleSeed score** — frontend must score ≥ 80 on design lock

## Testing Patterns

### Mock Providers

E2E tests use a stub upstream server (`stub-upstream.ts`) that simulates provider behavior:

- Configurable response delays
- Error injection (rate limit, auth failure, unavailable)
- Stream simulation
- Usage token reporting

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

### Semantic Routing Tests

Layer-2 semantic routing has unit and integration coverage across both planes:

- **Data-plane unit tests** (`packages/data-plane/src/semantic/`) — `classify.spec.ts` (cosine three-band classifier), `embedder.spec.ts` (stub embedder contract), `extract.spec.ts` (semantic input extractor with budget caps), `learning.spec.ts` (pure learning math: EMA fold, drift clamp, label-for-outcome)
- **Control-plane unit tests** (`packages/control-plane/src/semantic/`) — `bundle.spec.ts` (manifest schema, file-name traversal rejection), `embed-core.spec.ts` (WordPiece tokenizer + ONNX feed), `semantic-router.spec.ts` (Layer-2 verdict→evaluation mapping, skip-on-fault), `learning.run.spec.ts` (sweep occurrence: discard + apply passes), `learning-store.spec.ts` / `learning-store-redis.spec.ts` (Redis store atomic primitives), `semantic-learning-contributor.spec.ts` (evidence labelling + accumulation)
- **ONNX fixture** (`packages/control-plane/src/semantic/testing/onnx-fixture.ts`) — builds a tiny in-memory ONNX model + vocab for tests, no real model download needed
- **Boot e2e** (`test/semantic-boot.e2e-spec.ts`) — spawns a child process with `PATH`, `SEMANTIC_MODEL_PATH` unset/broken/valid and asserts boot behavior (fail-fast on broken, no-op on unset, capability true on valid)
- **Semantic routing e2e** (`test/proxy/semantic-routing.e2e-spec.ts`) — end-to-end Layer-2 routing with a real fixture model
- **Learning e2e** (`test/routing/semantic-learning.e2e-spec.ts`) — scheduled sweep, status endpoint, revert

The boot e2e tolerates ORT device-discovery stderr on Linux CI runners (onnxruntime-node emits `[W:onnxruntime:… GetPciBusId]` warnings on hardware whose PCI path doesn't match the expected pattern). ORT warning lines are filtered before asserting no boot error output.

## Adding New Tests

### Unit Test Checklist

- [ ] Test the happy path
- [ ] Test error conditions
- [ ] Test boundary values
- [ ] Mock external dependencies (Redis, HTTP)
- [ ] Verify metric emissions

### E2E Test Checklist

- [ ] Use real PostgreSQL and Redis
- [ ] Clean up test data in `afterEach`
- [ ] Test tenant isolation (cross-tenant reads)
- [ ] Test the full request pipeline
- [ ] Verify database state changes

### Golden File Test Checklist

- [ ] Record wire format from real provider (or realistic fixture)
- [ ] Verify IR fidelity after round-trip
- [ ] Cover streaming and non-streaming variants
- [ ] Cover tool use scenarios
- [ ] Cover error responses
