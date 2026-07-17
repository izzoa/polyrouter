## Why

Five routing backlog nits (FABLE_AUDIT A-21..A-25):

- **A-21** The cascade escalates to the (expensive) strong tier whenever the cheap chain fails outright —
  **including a non-retryable `bad_request`** (the client's request is malformed). The strong tier would
  400 too, so the escalation is wasted spend/latency.
- **A-22** The seeded `oai-miderror` cascade fixture (a strong model that errors mid-stream, post-commit)
  is never asserted — a regression in the mid-stream commit handling (invariant 3) could ship.
- **A-23** The structural-baseline EWMA seeds the full value from its first observation, so a single
  outlier first sample skews the baseline until it converges. (Accepted — see below.)
- **A-24** The routing-config spec lists `match_type` as `header`|`default`, but the code also supports
  `auto_high`/`auto_low` (structural bands). The spec contradicts the code.
- **A-25** No test asserts that a rule `target` naming ANOTHER tenant's model is rejected.

## What Changes

- **A-21** On a cheap-chain failure, escalate only when the failure is **retryable** (`shouldFallback`);
  a non-retryable `bad_request` is surfaced (4xx) with one recorded error row, no escalation.
- **A-22** Add an e2e that routes a streamed request to the seeded mid-error model and asserts the
  post-commit terminal error (status=error, no silent swap, no leaked upstream error text).
- **A-23 (accepted, no code change):** EWMA seeding from the first observation is standard and
  self-corrects over subsequent observations; the structural layer degrades to explicit/default
  (invariant 1), so a transiently-skewed baseline never affects correctness — only early routing
  optimization. A warmup-count fix is deferred (it would add per-field sample counts + change the read
  contract for a graceful-degradation signal).
- **A-24** Correct the spec's `match_type` enumeration to include `auto_high`/`auto_low`.
- **A-25** Add an e2e asserting a rule target naming another tenant's model is a 422.

## Capabilities

### Modified Capabilities

- `cascade-routing`: a non-retryable cheap-chain failure (bad_request) is surfaced, not escalated.
- `routing-config`: the rule `match_type` enumeration documents `auto_high`/`auto_low`.

## Impact

- **Code:** `proxy.service.ts` (guard the cascade escalation on `shouldFallback`). Tests: cascade e2e
  (bad_request no-escalate + mid-error terminal), routing-config e2e (cross-tenant rule target), a
  `badreq` stub mode. No schema change. No changeset (behavior-narrowing + tests + spec/doc).
