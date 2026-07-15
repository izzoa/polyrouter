# Tasks: add-ssrf-url-guard

## 1. The guard module

- [x] 1.1 `packages/shared/src/server/security/ssrf.ts`: `SsrfError` (typed `code`); `isBlockedIp(ip, { allowLoopback?, extraBlockedCidrs? })` backed by preloaded `net.BlockList`s — a **HARD** list (loopback [gated], metadata/link-local, mapped `::ffff:0:0/96`, `::/96`, NAT64 `64:ff9b::/96`+`64:ff9b:1::/48`, 6to4 `2002::/16`, discard `100::/64`, `fec0::/10`, multicast, reserved, `192.88.99/24`, doc ranges, `extraBlockedCidrs`) and a **SOFT** list (RFC1918/CGNAT/ULA); reject IPv6 zone ids; the enumerated set is versioned (no "all reserved" claim)
- [x] 1.2 `assertUrlSafe(url, options)` (HTTP(S) only): scheme rules (reject non-http(s); reject remote `http`; allow `http` only for proven-loopback under context or an allowed endpoint), derive `loopbackAllowed` from `context: { mode, providerKind }` inside the guard, **address- and port-bounded `allowedEndpoints` that reject at construction any CIDR overlapping the HARD set** and relax only SOFT space, injectable `resolve` (default `dns.lookup` all-addresses) rejecting if ANY resolved/literal IP is blocked; throws `SsrfError`
- [x] 1.3 `guardedFetch(url, init, options)` + `createGuardedDispatcher(options)` (caller-owned/closeable): undici connector that **resolves + validates candidate IPs BEFORE `net.connect`** (private/metadata listener gets no TCP/TLS), connects to the validated IP preserving Host/servername, re-checks `remoteAddress`; manual redirect loop (`redirect:'manual'`, `maxRedirects`=5) following only `301/302/303/307/308`, **rejecting cross-origin redirects**, aborting non-replayable bodies, cancelling intermediate bodies; add `undici` dependency to `packages/shared`
- [x] 1.4 Export all from `@polyrouter/shared/src/server/index.ts`; update spec.md §11.2 wording ("prefer https" → "require https for remote; http only for loopback/allowlisted")

## 2. Tests (spec §15 DoD)

- [x] 2.1 `isBlockedIp` unit tests: metadata, loopback, `0.0.0.0`, RFC1918, CGNAT, IPv6 (loopback/ULA/link-local), IPv4-mapped (dotted + hex canonical), NAT64, 6to4, discard, `192.88.99/24` all blocked; public v4/v6 allowed; loopback-only exception; `extraBlockedCidrs` honored; zone id rejected
- [x] 2.2 `assertUrlSafe` tests: metadata/localhost/RFC1918/IPv6/mapped URLs rejected; decimal/octal/hex IPv4 encodings, trailing-dot, userinfo (`http://public@169.254.169.254`) rejected; hostname resolving (injected) to private — and mixed public/private multi-record — rejected; `file://`/`gopher://` rejected; remote `http://` rejected; `https://` public accepted; `http://127.0.0.1` accepted only under selfhosted/local context; allowlist accept on CIDR+port, reject off-CIDR/off-port, and reject-at-construction for a HARD-overlapping CIDR
- [x] 2.3 `guardedFetch` integration test with a **real local listener asserting zero accepted connections**: name-time public + connect-time loopback (injected resolver differs) → rejected before connect, listener's connection handler never fires; a same-origin `3xx` Location to a private address → rejected on the re-validated hop; a **cross-origin** redirect → rejected without forwarding the `Authorization` header; a normal public fetch returns a response; a dispatcher open-handle/close check

## 3. Verification & bookkeeping

- [x] 3.1 `npm run build`, `npm test -w packages/shared`, `npm run lint` green; strict TS clean
- [x] 3.2 Changeset; TODOS.md board row #4 updated (size S→M)
