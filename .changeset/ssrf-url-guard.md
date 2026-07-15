---
'@polyrouter/shared': minor
---

Add the shared SSRF guard for outbound HTTP(S) URLs (spec §11.2, invariant 6): `isBlockedIp`/`classifyIp` over an enumerated IANA special-purpose range set (IPv4 + IPv6 + mapped/NAT64, per-family so mapped addresses can't bypass), `assertUrlSafe` (name-time gate — non-http(s)/zone-ids/remote-http rejected, rejects if any resolved IP is blocked, loopback exception derived from structured context, address- and port-bounded allowlist that can't relax the hard ranges), and `guardedFetch`/`createGuardedDispatcher` — the fetch callers must use — which validate every candidate address before the socket connects (DNS-rebinding + literal-IP defense) and reject cross-origin redirects so credentials never leak. Providers (#6/#7) and channels (#15) will consume it.
