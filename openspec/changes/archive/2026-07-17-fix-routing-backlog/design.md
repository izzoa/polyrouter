## Decisions

- **A-21:** in BOTH `cascadeCompletion` (buffered) and `cascadeStream` (streaming), when the cheap chain returns `!ok` and the client did not disconnect,
  branch on `shouldFallback(cheap.error.kind)`. A non-fallback kind (`bad_request`) records one error row
  and throws (surfacing the 4xx), rather than calling `escalateBuffered`. This mirrors the Layer-0
  fallback chain, which also never falls back on `bad_request`, so cheap→escalation is consistent with
  cheap-tier→cheap-fallback. Retryable failures (unavailable/rate_limit/auth) escalate as before.
- **A-22:** a scoped header rule (own id, removed in a `finally`) routes a streamed request directly to
  the seeded `strong-mid` (oai-miderror) tier — it does not disturb the band state other cascade tests
  rely on. Asserts the committed stream ends in a terminal error (recorded `status=error`) and the
  upstream error text never leaks (invariant 8).
- **A-24:** documentation — the code's `RULE_MATCH_TYPES` is the source of truth; the spec is corrected.
- **A-25:** a rule `target: model:<other tenant's model id>` returns 422 (write-time referential
  integrity is owner-scoped).
- **A-23 (accepted):** EWMA first-observation seeding is standard; the smart layer degrades safely.

## Risks / Trade-offs

- **A-21** narrows escalation: a cheap `bad_request` now surfaces instead of escalating. This is the
  intended behavior (a malformed request fails everywhere); existing cascade tests (retryable failures)
  are unaffected.

## Migration Plan

None — behavior-narrowing + tests + spec correction.
