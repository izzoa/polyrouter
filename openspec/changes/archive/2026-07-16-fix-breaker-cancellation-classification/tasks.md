# Tasks: fix-breaker-cancellation-classification

> Build order: breaker wrappers → chain threading → proxy wiring → tests → DoD. Additive data-plane seam (mirror of #21's `onBreakerState`); behavior flips ONLY for caller-abort cases (trip→neutral); every existing caller compiles untouched.

## 1. Data-plane

- [x] 1.1 `providers/breaker.ts`: `withBreaker(breaker, providerId, fn, onOpen?, onState?, isCallerAbort?)` — catch path settles `isCallerAbort?.() ? 'neutral' : outcomeForError(err)`. `withBreakerStream(..., onOpen?, onState?, isCallerAbort?)` — catch path settles `isCancellation(err) || isCallerAbort?.() === true ? 'neutral' : outcomeForError(err)`. Error-event settle-before-yield and the abandonment `finally` untouched.
- [x] 1.2 `proxy/core.ts`: `ProxyStreamOptions.isCallerAbort?: () => boolean` + the same on `runBufferedChain`'s ctx; forwarded to the wrappers at both call sites.

## 2. Control-plane wiring

- [x] 2.1 `proxy/proxy.service.ts`: pass `isCallerAbort: () => signal.aborted` at all six chain sites using the PURE client signal — for the cascade CHEAP chains explicitly the original request signal, NOT the `AbortSignal.any(client, deadline)` composite (a deadline abort must still trip — the chosen minimal variant).

## 3. Tests

- [x] 3.1 Data-plane unit (`breaker-caller-abort.spec.ts` or extend the state-listener spec): (i) repeated converted-shape failures (`ProviderError('unavailable')`) with `isCallerAbort` true, past the threshold → breaker never opens, next admission allows, `onOpen` never fires; the same WITHOUT the predicate → opens (regression pin). (ii) `withBreakerStream` teardown-throw: predicate true → neutral/no `justOpened`; predicate false → trips. (iii) `runBufferedChain` threads `ctx.isCallerAbort` (a member throwing while "client gone" leaves the breaker closed).
- [x] 3.2 Regression: full data-plane + control-plane unit and e2e suites green (the cascade cheap-deadline case keeps its existing tripping behavior — asserted by the existing suites staying green plus the timeout test in 3.1.ii).

## 4. Definition of done

- [x] 4.1 `npm run build` green; lint + prettier clean on touched files; strict TS, no `any`.
- [x] 4.2 Changeset (`@polyrouter/data-plane` patch + `@polyrouter/control-plane` patch). Confirm: false `provider_down` eliminated for disconnects; hung-provider detection unchanged; additive API only.
- [x] 4.3 Archive the change (fallback-routing delta merged); note the fix closes the follow-up flagged in #21's changeset.
