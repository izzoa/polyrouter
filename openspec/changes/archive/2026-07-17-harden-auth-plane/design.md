## Context

Two small, self-contained auth-plane hardening fixes. Both are defense-in-depth: `@CurrentPrincipal`
throwing compensates today, but the spec mandates the stronger posture.

## Goals / Non-Goals

**Goals:** per-client rate-limit isolation behind an IPv6 proxy; a case-insensitive plane boundary so
`/API/...` is scoped exactly like `/api/...`.

**Non-Goals:** changing the rate-limit windows, the Redis Lua, the credential planes, or Express's
default case-insensitive controller routing (we normalize at the plane-decision sites instead).

## Decisions

### E9.1 — IPv6-aware client IP

Replace the hand-rolled IPv4 bit math in `ipInCidr` with Node's `net.BlockList` (natively handles IPv4,
IPv6, and IPv4-mapped) driven by a SINGLE strict CIDR parser shared with the boot validation:

```
// STRICT: bitsStr must be non-empty decimal — clink round 1 caught that
// Number('')===0, so `10.0.0.0/` would parse as /0 = TRUST EVERY PEER (XFF spoof).
function parseCidr(cidr): { range, bits, family } | null {
  const slash = cidr.lastIndexOf('/'); if (slash < 0) return null;
  const range = cidr.slice(0, slash); const bitsStr = cidr.slice(slash + 1);
  if (!/^\d+$/.test(bitsStr)) return null;          // rejects '', '-1', '0x1f', '1e2'
  const bits = Number(bitsStr); const family = isIP(range);
  if (family === 0 || bits > (family === 6 ? 128 : 32)) return null;
  return { range, bits, family };
}
function ipInCidr(ip, cidr): boolean {
  const c = parseCidr(cidr); const af = isIP(ip); if (!c || af === 0) return false;
  try { const bl = new BlockList(); bl.addSubnet(c.range, c.bits, c.family === 6 ? 'ipv6' : 'ipv4');
        return bl.check(ip, af === 6 ? 'ipv6' : 'ipv4'); } catch { return false; }
}
```

`clientIp` keeps the `::ffff:` peer normalization (a mapped-v4 peer checks against v4 CIDRs) and the
"XFF last hop only when peer ∈ trusted CIDR" rule (single-hop trust — multi-proxy chains bucket by the
adjacent proxy; not worsened here, documented as single-hop). `ipInCidr` runs only on the
auth-rate-limited routes (`matchRule` returns non-null first), so the per-call `BlockList` allocation is
negligible. Boot validation is a Zod `.refine` using the SAME `parseCidr`, so a malformed/mixed CIDR
fails fast (naming the var, not the value) — closing the empty-suffix `/0` "trust all" hole.

*Alternative rejected:* hand-rolled 128-bit BigInt v6 parsing — more code and more edge cases than the
platform primitive built for exactly this.

### E9.2 — Case-insensitive plane check

Express routes case-insensitively by default, but the plane guards compare a case-sensitive prefix.
Introduce shared, case-insensitive, **segment-safe** plane predicates and use them at EVERY
plane-scoping decision (clink round 1 — the original 3-site list was incomplete; the SPA one is
security-critical):

```
const isApiPath = (p) => { const l = p.toLowerCase(); return l === '/api' || l.startsWith('/api/'); };
const isV1Path  = (p) => { const l = p.toLowerCase(); return l === '/v1'  || l.startsWith('/v1/');  };
```

Sites:
- `SessionGuard` `/api` scope → `!isApiPath(req.path)` (the core fix: `/API/agents` is now guarded → 401).
- **`spa.ts` SPA fallback** reserves `/api` + `/v1` → `isApiPath || isV1Path`. **Security-critical:** without
  this, in production the SPA shell is served for `/API/agents` BEFORE Nest, so the guard never runs and
  the 401 acceptance fails.
- `mount.ts` `isV1` (v1 big-body plane) → `isV1Path`; the Better-Auth interception → lowercased
  `startsWith('/api/auth')`; `protocolForPath` (error shape) → lowercase its suffix compare.
- `rate-limit.ts` `matchRule` → lowercase the path before `startsWith(rule.prefix)` (uppercase auth
  routes are throttled).
- `proxy-exception.filter.ts` `/v1` error-envelope scope → `isV1Path`.

**Better Auth caveat (clink round 1):** lowercasing the *interception* predicate makes `/API/auth/*`
reach Better Auth and be throttled, but Better Auth's own router is case-sensitive on its `basePath`, so
an uppercase auth path returns Better Auth's 404 rather than functionally signing in. That is safe (no
bypass) and out of scope to change — so the requirement/tests assert only that uppercase `/API/...` is
**guarded and throttled** (can't slip the plane), NOT that an uppercase sign-in completes. (Segment-safe
predicates also fix a latent overmatch — `/apiary` no longer folds into the `/api` plane.)

*Alternative rejected:* `app.set('case sensitive routing', true)` — a global routing-semantics change
with broader blast radius (every controller route) for a plane-boundary bug.

## Risks / Trade-offs

- **[BlockList per call]** — negligible: only auth routes reach `clientIp`, and `BlockList` construction
  is a handful of subnets. If the auth surface ever grows hot, memoize by the (stable) CIDR set.
- **[toLowerCase on every request path]** — `matchRule`/`isV1` run per request; `toLowerCase()` on a
  short path is trivial and the plane checks were already O(path).

## Migration Plan

Code-only; no schema migration. `TRUSTED_PROXY_CIDRS` validation only rejects input that never worked
(a malformed CIDR was silently ignored before); a valid existing config is unaffected. Rollback is a revert.

## Open Questions

None.
