# Design: add-ssrf-url-guard

## Context

Nothing fetches user URLs yet, but #6 (adapters), #7 (provider CRUD) and #15 (channels) will, and spec §11.2 + invariant 6 demand every such fetch be SSRF-validated with a DNS-rebinding defense. This change lands the shared guard first so those paths are safe by construction. It lives in `@polyrouter/shared/server` (both planes fetch user URLs), config-free like the encryption util (context passed in). Round-1 codex review reshaped it substantially — the load-bearing control is a **guarded fetch with a socket-level connector**, not bare node agents.

## Goals / Non-Goals

**Goals:** a correct blocked-range predicate (IPv4 + IPv6 + mapped + NAT64), a validation-time HTTP(S) URL gate, and a **fetch-compatible guarded transport that re-validates every redirect hop and the actual connected socket IP** — the real rebinding/redirect/literal-IP defense — plus a structured loopback exception and a rejection suite proving the §15 criterion for HTTP(S) URLs.

**Non-Goals:** wiring callers (#6/#7/#15), reading `MODE`/config internally, egress controls, Apprise scheme-specific (`discord://`, `tgram://`…) validation (that's #15's protocol extraction), allowlist persistence.

## Decisions

1. **Range checks via a preloaded `net.BlockList`, blocking all IPv4-mapped and NAT64 IPv6 wholesale.** BlockList checks CIDR membership natively. Rather than textually unwrap mapped addresses (WHATWG canonicalizes `::ffff:127.0.0.1` to `::ffff:7f00:1`), I **block the entire `::ffff:0:0/96` (IPv4-mapped) and `::/96` (deprecated IPv4-compatible) ranges** — no legitimate resolver returns a mapped address, and a mapped *literal* in a URL is always suspicious — so `::ffff:169.254.169.254` (in any textual form) is blocked without fragile unwrapping. `extraBlockedCidrs` lets a deployment add network-specific NAT64 prefixes.

2. **Blocked ranges are the enumerated IANA special-purpose set (versioned; not a vague "reserved" claim — codex r2 #4), split into HARD and SOFT tiers (codex r2 #1).** The **HARD** set is never overridable by an allowlist: IPv4 `0.0.0.0/8`, `127/8` (loopback — un-blocked only under the loopback exception), `169.254/16` (link-local **incl. metadata**), `192.0.0/24`, `192.0.2/24`, `192.88.99/24` (deprecated 6to4 relay), `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4` (multicast), `240/4` (reserved), `255.255.255.255`; IPv6 `::/128`, `::1/128`, `::/96`, `::ffff:0:0/96` (mapped), `64:ff9b::/96` + `64:ff9b:1::/48` (NAT64), `100::/64` (discard), `2001::/23` (IETF protocol), `2001:db8::/32` (doc), `2002::/16` (6to4), `3fff::/20`, `5f00::/16`, `fe80::/10` (link-local), `fec0::/10` (deprecated site-local), `ff00::/8` (multicast); plus caller `extraBlockedCidrs`. The **SOFT** set (private LANs an operator may deliberately reach) — IPv4 `10/8`, `172.16/12`, `192.168/16`, `100.64/10` (CGNAT); IPv6 `fc00::/7` (ULA) — is blocked by default but MAY be relaxed by an address-bounded allowlist entry (decision 4). A hostname is resolved and **reject if ANY resolved address is blocked** (a public+private split must not pass). An IPv6 **zone id** (`%eth0`) is rejected outright. The normative spec claims exactly this enumerated list, not completeness.

3. **The loopback exception takes structured context, derived inside the guard.** Options carry `context: { mode: 'selfhosted' | 'cloud'; providerKind?: string }`, not a raw `allowLoopback` boolean — so a caller cannot accidentally open loopback in cloud. The guard derives `loopbackAllowed = mode === 'selfhosted' && providerKind === 'local'`, and it un-blocks **loopback only** (`127/8`, `::1`); metadata and every other private range stay blocked. Self-host LAN model servers use the address-bounded allowlist (decision 4), not a private-range opening.

4. **Allowlist is address- and port-bounded, and can only relax SOFT ranges (fixes the metadata-exemption hole + codex r2 #1).** `allowedEndpoints: Array<{ host: string; cidr: string; port?: number }>` trusts a host **only when its resolved/connected IP falls inside the declared CIDR and the port matches** (when `port` is given) — so an allowlist entry targets one service on one network, not every port on a LAN host. Its CIDR **MUST NOT overlap the HARD set** (loopback/metadata/mapped/NAT64/multicast/reserved/`extraBlockedCidrs`); a construction-time check **rejects an overlapping entry**, so a cloud caller cannot allowlist `127.0.0.1/8` or mapped/metadata space. Only SOFT ranges (RFC1918/CGNAT/ULA) or public space may be allowlisted. Exact host match. (Empty by default; #7 decides where endpoints are stored.)

5. **`https` required for remote; `http` only for a proven-loopback or allowlisted destination (spec hardening, recorded in spec.md).** Non-`http(s)` schemes are always rejected. `http` is permitted only when the resolved destination is loopback under `loopbackAllowed`, or the host is an allowed endpoint whose policy permits it — never for a public destination. This hardens spec §11.2's "prefer https" to "require https for remote"; **spec.md §11.2 is updated in this change** to record it (source of truth stays current).

6. **The load-bearing control is `guardedFetch`, not node agents (fixes the fetch-bypass blocker); validation happens BEFORE the socket connects (codex r2 #2), and redirects can't leak credentials (codex r2 #3).** Node's global `fetch` uses an undici dispatcher, so a `node:http`/`https` Agent would not protect it, and a `lookup` hook is skipped for literal IPs. `guardedFetch(url, init, options)` therefore:
   - runs `assertUrlSafe` on the initial URL, then follows redirects **manually** (`redirect: 'manual'`, bounded by `maxRedirects`=5). **Cross-origin redirects are rejected** (an `SsrfError`), not followed — the safe way to avoid forwarding a provider's `Authorization`/cookies/body to an attacker-controlled origin (replicating the full WHATWG strip-on-origin-change semantics is error-prone). Same-origin redirects are re-validated per hop, only `301/302/303/307/308` with a valid `Location` are followed, a non-replayable (streaming) body aborts on redirect, and **every intermediate response body is cancelled** so connections aren't retained;
   - dispatches through a **custom undici connector that resolves the hostname with the guarded resolver and rejects any blocked candidate address BEFORE `net.connect`** (so a private/metadata listener never even receives a TCP connection — inspecting `remoteAddress` only *after* connecting would still allow a port scan and a TLS ClientHello), then connects to the validated IP while preserving the original `Host`/TLS `servername`, and re-checks `remoteAddress` post-connect as defense-in-depth. Literal-IP destinations are validated before connect too.
   `undici` is an explicit dependency. **`createGuardedDispatcher(options)` is the caller-owned, closeable lifecycle** (one dispatcher reused across calls, not an Agent per fetch — avoids leaked pools); `guardedFetch` uses a module default, and callers with distinct policies build their own. `#6/#15` must use `guardedFetch`/`createGuardedDispatcher`, never a bare `fetch`.

7. **Resolution is injectable (`resolve` option, default `dns.lookup` all-addresses).** `assertUrlSafe` uses it at name-time; tests inject a resolver that returns public at name-time and private at connect-time to simulate rebinding deterministically. But the **real** rebinding guarantee is the socket connector (decision 6), which is proven by an **integration test against a real local listener** where the injected connect-time resolver returns loopback: the guard rejects **before connecting**, so the listener's connection handler **never fires** (the test asserts zero accepted TCP connections, not merely zero HTTP bytes).

8. **Typed, non-leaking rejections.** `assertUrlSafe`/`guardedFetch` throw `SsrfError` with a `code` (`blocked_ip` / `bad_protocol` / `not_https` / `unresolvable` / `too_many_redirects` / `cross_origin_redirect`); messages name the reason, never resolver internals or the target's internals.

## Risks / Trade-offs

- [fetch integration correctness] → `guardedFetch` owns redirects (manual, per-hop revalidated, cross-origin rejected, intermediate bodies cancelled) and the connector validates candidate IPs **before connecting**; literal IPs and rebinding are covered because a blocked address is refused before any TCP/TLS handshake.
- [credential leakage on redirect] → cross-origin redirects are rejected outright, so `Authorization`/cookies/body never cross to another origin; same-origin hops are re-validated.
- [allowlist over-reach] → allowlist entries are port-bounded, cannot overlap the HARD range set (construction-time reject), and can only relax SOFT (RFC1918/CGNAT/ULA) space — loopback/metadata/mapped stay hard-blocked.
- [dispatcher lifecycle] → `createGuardedDispatcher` is caller-owned and closeable; `guardedFetch` reuses a module default rather than minting an Agent per call.
- [Blocking all IPv4-mapped/`::/96`] → rejects the (illegitimate) mapped-literal URL form wholesale; real resolvers never return mapped addresses, so no legitimate destination is lost.
- [Allowlist as a CIDR-bound endpoint] → more structure than a hostname set, but a plain hostname allowlist was a metadata-bypass; the CIDR binding is the safe form and metadata/link-local stay hard-blocked regardless.
- [`undici` dependency] → small, already the engine behind Node's fetch; needed for a dispatcher-level connector since node Agents don't apply to fetch.
- [require-https hardening vs spec "prefer"] → recorded by updating spec.md §11.2, consistent with prior spec syncs; loopback/allowlisted endpoints may still use http.
- [Non-HTTP Apprise schemes] → out of scope by design; this guard validates HTTP(S) URLs (`APPRISE_API_URL`, webhook endpoints); #15 does scheme-specific extraction/validation and constrains the Apprise container's egress.

## Migration Plan

Pure addition (new module + tests + `undici` dep) plus a spec.md §11.2 wording sync. Rollback = remove the module and revert the wording.

## Open Questions

None blocking. (Where trusted endpoints are persisted is a #7/#15 decision.)
