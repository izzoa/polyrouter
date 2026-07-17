## 1. E9.1 — IPv6-aware client IP + strict CIDR validation

- [x] 1.1 In `client-ip.ts`, add a strict `parseCidr(cidr)` (reject a non-`/^\d+$/` prefix — closes the `Number('')===0` → `/0` trust-all hole; `isIP(range)!==0`; `bits ≤ family width`) and rewrite `ipInCidr` to use it + `net.BlockList` (`addSubnet`/`check`, family-aware, false on any error). Keep `clientIp`'s `::ffff:` normalization + trusted-peer XFF rule. Export `parseCidr`.
- [x] 1.2 In `auth.config.ts`, add a `.refine` on `TRUSTED_PROXY_CIDRS` (after the csv transform) using the SAME `parseCidr` — every entry must parse, else boot fails fast (var named, value un-echoed).
- [x] 1.3 New `client-ip.spec.ts`: `clientIp({peer:'fd00::1', xff:'2001:db8::5'}, ['fd00::/8'])` → `'2001:db8::5'`; two distinct v6 XFFs → distinct; untrusted v6 peer → the peer; v4 peer+v4 CIDR still works; mapped `::ffff:1.2.3.4` peer matches a v4 CIDR. `parseCidr` rejects `10.0.0.0/` (empty), `10.0.0.0/-1`, `10.0.0.0/33`, `fd00::/129`, `10.0.0.0/0x1`, and accepts `10.0.0.0/8` + `fd00::/8`. Auth-config test: a malformed CIDR fails validation.

## 2. E9.2 — Case-insensitive, segment-safe plane predicates

- [x] 2.1 Add shared `isApiPath`/`isV1Path` (lowercase + segment-safe: `=== '/api'` or `startsWith('/api/')`) in a small auth util; export for reuse.
- [x] 2.2 `session.guard.ts`: `if (!isApiPath(req.path)) return true`.
- [x] 2.3 `spa.ts`: the SPA fallback reserves the API/proxy planes via `isApiPath(path) || isV1Path(path)` (**security-critical** — otherwise `/API/agents` is served the SPA before the guard).
- [x] 2.4 `mount.ts`: `isV1` → `isV1Path`; the Better-Auth interception → `req.path.toLowerCase().startsWith('/api/auth')`; `protocolForPath` compares a lowercased suffix. `proxy-exception.filter.ts`: `/v1` scope → `isV1Path`. `rate-limit.ts` `matchRule`: lowercase the path before `startsWith(rule.prefix)`.
- [x] 2.5 e2e: `GET /API/agents` without a session → 401 (guarded, not served the SPA, not 500); `/API/auth/request-password-reset` is throttled to 429 after its limit (the limiter matched the uppercase path). Do NOT assert an uppercase sign-in *succeeds* (Better Auth's basePath is case-sensitive → a safe 404); assert only guarding + throttling.

## 3. Verification & wrap-up

- [x] 3.1 `npm run build && npm run lint && npm run typecheck` clean.
- [x] 3.2 `npm test -w packages/control-plane` green (new client-ip + parseCidr + auth-config units); `npm run test:e2e -w packages/control-plane` green (uppercase-path cases; auth flake re-run in isolation).
- [x] 3.3 Changeset (user-facing: IPv6 trusted-proxy support + strict CIDR validation + case-insensitive plane boundary).
- [x] 3.4 Update `TODOS.md` board + mark E9 tasks ✅ in `FABLE_AUDIT.md` after archive.
