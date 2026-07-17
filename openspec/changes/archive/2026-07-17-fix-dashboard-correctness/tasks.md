## 1. E12.1 — Route mid-session 401s back to the login gate

- [x] 1.1 In `state/appState.ts`, add an inner `err(e)` in `createAppStore` (after `say`) that, when `isApiError(e) && e.status===401 && state.authView==='ready'`, calls `void bootstrap()`, then returns `errMessage(e)`. Replace the in-closure `errMessage(e)` call sites with `err(e)` (leave the module-level `errMessage` as the delegate).
- [x] 1.2 Vitest: a `ready` store whose next loader/mutation gets `ApiError(401)` flips `state.authView` to `'gate'`; a non-401 error does not.

## 2. E12.2 — Clipboard copy is authoritative

- [x] 2.1 In `state/appState.ts`, rewrite `copy` (keep the `=> void` signature): run an awaited IIFE that throws when `navigator.clipboard` is absent, `await`s `writeText`, toasts `msg ?? 'Copied'` only on success, and toasts a distinct `'Copy failed — select the text manually'` on failure/rejection.
- [x] 2.2 Vitest: stub `navigator.clipboard` undefined → failure toast (not "Key copied"); stub `writeText` rejecting → failure toast; a resolving `writeText` → the success toast.

## 3. E12.3 — Endpoint derived from runtime origin

- [x] 3.1 In `data/catalog.ts`, set `BASE_URL = \`${globalThis.location.origin}/v1\`` (runtime origin, evaluated at load) so the endpoint chip / Settings / Agents / `snippetFor` all match the serving origin and the server-minted snippet.
- [x] 3.2 In `components/Sidebar.tsx`, replace the `127.0.0.1:3001` host literal with `globalThis.location.host`. (The `v0.4.1` version string is backlog A-30, out of scope.)

## 4. E12.4 — Setup guide does not wipe an existing default chain

- [x] 4.1 In `state/appState.ts` `obConnectProvider`, add a single-flight guard (`if (state.ob.busy2) return`) so a double-click can't mint a duplicate provider / race the append; read `listTierEntries(def.id)` first; if the model is absent and the tier is already full (`MAX_MODELS_PER_TIER`), set `error2`/leave `done2` false (no phantom assignment) and return; otherwise `nextIds = alreadyRouted ? existingIds : [...existingIds, first.id]` and call `replaceTierEntries` only when `nextIds` differs from `existingIds` (empty default → `[first]`, unchanged onboarding; non-empty → append; already-present → no-op but still completes).
- [x] 4.2 Vitest: seed a 2-entry `default`, run `obConnectProvider`, assert the two existing modelIds are preserved (order kept, new model appended) and the write was not a single-element replace; a fresh (empty) default still results in `[first]`; a full (5-entry) default surfaces the "tier full" error with no write.

## 5. Verification & wrap-up

- [x] 5.1 `npm run build && npm run lint && npm run typecheck` clean.
- [x] 5.2 `npm test -w packages/frontend` green (new E12.1/E12.2/E12.4 specs + existing suite).
- [x] 5.3 Changeset (user-facing: mid-session re-auth, honest copy, origin-correct endpoint, non-destructive setup guide).
- [x] 5.4 Update `TODOS.md` board + mark E12 ✅ in `FABLE_AUDIT.md` after archive.
