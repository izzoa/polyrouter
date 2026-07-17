## Context

Four independent SPA defects, all in `state/appState.ts` plus one display constant. Each has a narrow,
low-risk fix; the theme is "don't silently do the wrong thing" (strand, lie about a copy, wipe a chain,
show a stale endpoint). Frontend-only; no API or schema change.

## Decisions

### D1 — Central 401 reroute via a shared `err()` wrapper (E12.1)

Every loader/mutation catch funnels through the module-level `errMessage(e)` (35 sites). `errMessage`
is a pure formatter defined outside the store closure, so it can't reach `bootstrap`. Introduce an
inner `err(e)` **inside** `createAppStore` that does the reroute then delegates to `errMessage`:

```ts
const err = (e: unknown): string => {
  if (isApiError(e) && e.status === 401 && state.authView === 'ready') void bootstrap();
  return errMessage(e);
};
```

and replace the in-closure `errMessage(e)` call sites with `err(e)`. `err` references `bootstrap`
(a `const` declared later in the same closure) — safe because `err` is only ever *called* from async
catch handlers that run long after the closure finishes initializing (no runtime TDZ). The `ready`
guard is what prevents recursion: during `bootstrap()` itself `authView` is `'loading'`, and on the
login gate it is `'gate'`, so neither re-triggers the reroute. `bootstrap()` already handles its own
`me()` 401 (→ `gate`) and reloads `login-config` for the OAuth buttons, so the reroute reuses the exact
gate path rather than duplicating it.

### D2 — `copy()` stays `=> void`, awaits internally (E12.2)

The public signature `copy: (txt, msg?) => void` is kept so no `onClick={() => app.copy(...)}` handler
or the `AppStore` interface changes (returning a Promise would trip `no-misused-promises` on the void
event handlers). Internally it runs an awaited IIFE:

```ts
const copy = (txt: string, msg?: string): void => {
  void (async () => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(txt);
      say(msg ?? 'Copied');
    } catch {
      say('Copy failed — select the text manually');
    }
  })();
};
```

A missing `navigator.clipboard` (non-secure origin — plain http on a LAN IP, the common self-host case)
is treated as failure, so the toast never falsely claims success and the user knows to select the text
before dismissing the shown-once key reveal.

### D3 — `BASE_URL` from `location.origin` (E12.3)

`export const BASE_URL = \`${globalThis.location.origin}/v1\`;` — evaluated at module load in the browser
(and jsdom under test). Same-origin serving makes this correct in prod, matches the Vite-proxied dev
origin, and agrees with the server-minted key-reveal snippet. Consumers (`Topbar`, `Settings`, `Agents`,
`snippetFor`) read the same const, so they all follow. The sidebar footer's separate host literal
(`127.0.0.1:3001`) is switched to `globalThis.location.host` (host + port, no scheme). The sidebar's
`v0.4.1` version string is a different defect (backlog A-30) and out of scope here.

### D4 — Read-before-replace in `obConnectProvider` (E12.4)

Before assigning, read the default tier's current entries and only full-replace when it is empty;
otherwise append the new model within the 5-cap and no-op if already present:

```ts
if (state.ob.busy2) return; // single-flight: a double-click must not mint a dup provider / race the append
// …create provider, sync, pick `first`, resolve `def`…
const existing = await client.listTierEntries(def.id);
const existingIds = existing.map((e) => e.modelId);
const alreadyRouted = existingIds.includes(first.id);
if (!alreadyRouted && existingIds.length >= MAX_MODELS_PER_TIER) {
  setState('ob', { busy2: false, error2: `Default tier already has ${MAX_MODELS_PER_TIER} models — …` });
  return; // full + absent: no phantom "assigned" success
}
const nextIds = alreadyRouted ? existingIds : [...existingIds, first.id];
if (nextIds.join('\n') !== existingIds.join('\n')) await client.replaceTierEntries(def.id, nextIds);
```

Appending puts the new model *after* the existing chain, so the user's existing primary (position 0)
and fallbacks are preserved — the destructive single-element replace only happens on a genuinely empty
default (fresh-instance onboarding, unchanged). When the tier is already **full** (`MAX_MODELS_PER_TIER`)
and the model is absent, the step does **not** write and does **not** claim success: it sets `error2`
("Default tier already has 5 models …") and leaves `done2` false, so the guide never reports a phantom
assignment (a "tier full" confirm-to-replace UX is deferred). When the model is already routed, it
no-ops the write but still completes (`done2`), since the assignment goal is already satisfied.

## Risks / Trade-offs

- **`err()` fires `bootstrap()` on any ready-state 401.** A single spurious 401 (e.g. a race) would
  bounce to the gate; but a real expired session is exactly this case, and `bootstrap` re-probes
  `/api/me` — if the session is actually valid it returns straight to `ready`. Net safe.
- **E12.4 full-tier edge:** a 5-entry default + a new onboarding model → the new model isn't added
  (chain preserved, no wipe) and the step reports a "tier full" error rather than a phantom success. A
  confirm-to-replace UX is backlog.
- **E12.4 read-then-replace is not atomic (known residual).** `listTierEntries` then a full
  `replaceTierEntries` has a TOCTOU window: a concurrent tier edit (another tab, or a rapid second
  submit) between the GET and PUT can be lost, because the routing API is a full-list replace (this race
  is inherent to *every* tier write in the app, e.g. the routing-page reorder — not new to this change).
  Same-tab double-submit is already bounded by the `busy2` guard. A fully atomic fix needs a server-side
  append-if-absent (or ETag/optimistic-concurrency) endpoint — a backend change, out of this
  frontend-only scope. Even so, this is a strict improvement over the prior unconditional wipe.
- **E12.1 bootstrap-window 401 (known minor residual).** The reroute guard is `authView==='ready'`, but
  `bootstrap()` runs its initial `loadAgents`/`loadProviders` while `authView` is still `'loading'`. If
  `/api/me` succeeds yet the session is invalidated in the sub-second window before those two parallel
  loaders fire, their 401s are swallowed and bootstrap still enters `ready`. The next user action or the
  15s analytics poll re-gates via the same `err()` path, so the user self-heals on any further
  interaction; only a page that both never polls and is never touched again stays stale. Closing this
  fully needs a single-flight re-probe inside bootstrap (deferred — the common mid-session-expiry case
  E12.1 targets is fully covered).

## Migration Plan

None — frontend-only, no persisted-state or API change. Effective on next SPA load.

## Open Questions

- Should E12.4 prepend (new model as primary) instead of append? Append preserves the user's chosen
  primary, which is the safer default for someone re-walking the guide; prepend would silently demote
  their primary. Chose append.
