## 1. A-21 — non-retryable cheap failure is not escalated

- [x] 1.1 In `proxy.service.ts` BOTH `cascadeCompletion` (buffered) AND `cascadeStream` (streaming), when the cheap chain fails and the client is present, escalate only when `shouldFallback(cheap.error.kind)`; a non-retryable `bad_request` records one error row and surfaces the 4xx (no escalation).
- [x] 1.2 e2e (cascade): a `badreq` stub mode + cheap-badreq tier; a buffered AND a streamed cascade with a bad_request cheap leg both record + a cheap-badreq tier; a cascade with a bad_request cheap leg records `escalated=false`, `modelId=cheapBadReq`, and returns a 4xx (not the strong tier).

## 2. A-22 — assert the mid-error strong fixture

- [x] 2.1 e2e: drive the seeded `strong-mid` (oai-miderror) fixture THROUGH the cascade (cheap fails quality → escalate → strong tier streams a token then errors); assert decisionLayer=cascade, escalated=true, status=error, no leaked SECRET.

## 3. A-24 — spec match_type

- [x] 3.1 Correct the routing-config rule requirement's `match_type` to `header`|`default`|`auto_high`|`auto_low`.

## 4. A-25 — cross-tenant rule target

- [x] 4.1 e2e: a rule `target: model:<other tenant's model>` returns 422.

## 5. A-23 — accepted

- [x] 5.1 Document (proposal/design) that EWMA first-observation seeding is accepted (self-corrects; graceful-degradation layer); no code change.

## 6. Wrap-up

- [x] 6.1 build/lint/typecheck green; cascade + routing-config e2e green.
- [x] 6.2 Update TODOS + mark A-21..A-25 ✅ in FABLE_AUDIT after archive.
