# Proposal: add-ssrf-url-guard

> Implements **TODOS.md #4 `add-ssrf-url-guard`** — spec.md **§11.2** (outbound-URL safety), **§8** (custom-provider base_urls), **§10.1** (Apprise/webhook targets, `APPRISE_API_URL`), **§15** (SSRF acceptance criterion). CLAUDE.md invariant **6**.

## Why

Custom providers (#6/#7) and notification targets (#15) let a user hand the **server** a URL it will then fetch — a serious SSRF vector: a URL pointed at `169.254.169.254`, `localhost`, or an internal service can exfiltrate cloud-metadata credentials or reach private infra (spec §11.2). Landing one shared, well-tested guard **now** — before any code fetches a user- or env-supplied URL — means every later fetch path is validated by construction, and the DNS-rebinding defense (validate the *resolved* IP at connect time, not just the hostname) exists from the start rather than being retrofitted onto N call sites.

## What Changes

- **A shared SSRF guard for HTTP(S) URLs** in `@polyrouter/shared/server` (both planes fetch user URLs; node-only, beside the encryption util — config-free, context passed in like keys are):
  - `isBlockedIp(ip, opts)` — pure predicate blocking private / loopback / link-local / metadata / CGNAT / multicast / reserved ranges, **IPv4 and IPv6**, and **all IPv4-mapped and NAT64 forms wholesale** so they can't bypass.
  - `assertUrlSafe(url, options)` — **validation-time** gate for HTTP(S): reject non-`http(s)` and IPv6 zone ids; require `https` for remote (`http` only for a proven-loopback or allowlisted destination); resolve and **reject if ANY resolved IP is blocked**.
  - `guardedFetch(url, init, options)` — the **fetch-compatible transport callers use**: it re-validates **every redirect hop** (manual, bounded) and dispatches through an undici connector that **validates the actual connected socket IP** — the real defense against DNS rebinding, literal-IP redirects, and the fetch-bypass that plain node agents suffer. `createGuardedConnector` is exported for callers building their own dispatcher.
- **The loopback exception takes structured `context: { mode, providerKind }`** and derives `loopbackAllowed` **inside** the guard (so a caller can't accidentally open loopback in cloud); it un-blocks **loopback only** — metadata and other private ranges stay blocked. Self-host LAN model servers use the **address-bounded allowlist** (`allowedEndpoints: {host, cidr}` — a host is trusted only when its IP is in its CIDR, and metadata/link-local stay blocked even then).
- **DNS resolution is injectable** (`resolve` option) for deterministic name-time tests; the **real** rebinding guarantee (the socket connector) is proven by an **integration test against a local listener**.
- **SSRF-rejection suite** (spec §15 DoD, HTTP(S)): metadata, `localhost`, RFC1918, IPv6 equivalents, mapped/NAT64, decimal/octal/hex encodings, userinfo/trailing-dot tricks, redirect-to-private, and a **socket-path rebinding** case are all rejected; loopback accepted only under the selfhosted/local context. End-to-end CRUD proof stays with #7/#15.

## Capabilities

### New Capabilities

- `ssrf-url-guard`: the outbound-URL validation module — blocked-range predicate, validation-time URL gate, connect-time rebinding defense, the loopback exception, and its rejection test suite.

## Impact

- **Code:** `packages/shared/src/server/security/ssrf.ts` (+ export from `@polyrouter/shared/server`) and its Vitest suite; a `undici` dependency in `packages/shared` (needed for a dispatcher-level connector — node agents don't protect `fetch`); a spec.md §11.2 wording sync ("prefer https" → "require https for remote"). No schema, no endpoints, no config vars.
- **Downstream:** #6's adapters make custom/local outbound calls via `guardedFetch`; #7's provider CRUD calls `assertUrlSafe` on base_urls; #15's channel CRUD calls it on HTTP(S) webhook targets **and `APPRISE_API_URL`** (and does scheme-specific extraction for non-HTTP Apprise URLs + Apprise-container egress control). Each passes `context: { mode, providerKind }` derived from `MODE` and provider kind.

## Non-goals

- **No callers wired** — providers (#6/#7), channels (#15), and their `MODE` gating are their own changes; this ships the guard and its tests only.
- **No network egress controls** — cloud-deployment egress policy is a #22/ops concern; this is the application-layer guard.
- **No config vars** — the guard takes options; `MODE` reads and `APPRISE_API_URL` registration belong to the consuming changes.
- **No allowlist management UI/persistence** — the guard accepts an allowlist parameter; where allowlists are stored is a later concern (none needed yet).
