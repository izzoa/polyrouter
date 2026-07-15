# ssrf-url-guard — delta

## ADDED Requirements

### Requirement: Blocked-range predicate covers the enumerated IANA special-purpose ranges for both IP families
`@polyrouter/shared/server` SHALL provide `isBlockedIp(ip, options?)` returning true for an enumerated, versioned set of IANA special-purpose ranges (not a vague "all reserved" claim) spanning private, loopback, link-local (including the `169.254.169.254` metadata address), CGNAT, multicast, and documented/reserved ranges across **IPv4 and IPv6**, and for **all IPv4-mapped IPv6 (`::ffff:0:0/96`), deprecated IPv4-compatible (`::/96`), NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), 6to4 (`2002::/16`), discard (`100::/64`), and deprecated site-local (`fec0::/10`) addresses**, so a mapped/NAT64/6to4 form cannot bypass the check. The set is split into a **HARD tier** (loopback/metadata/mapped/NAT64/multicast/reserved — never overridable by an allowlist) and a **SOFT tier** (RFC1918/CGNAT/ULA — relaxable only by an address-bounded allowlist entry). It SHALL accept deployment-supplied `extraBlockedCidrs` (HARD). When loopback is allowed, loopback addresses (`127/8`, `::1`) — and only those — SHALL NOT be blocked; metadata and every other range SHALL remain blocked.

#### Scenario: Dangerous addresses are blocked in both families and mapped/NAT64 forms
- **WHEN** `isBlockedIp` is called with `169.254.169.254`, `127.0.0.1`, `0.0.0.0`, `10.0.0.1`, `192.168.1.1`, `::1`, `fd00::1`, `fe80::1`, `::ffff:169.254.169.254`, or a `64:ff9b::` NAT64 form
- **THEN** it returns true for each

#### Scenario: Public addresses are allowed
- **WHEN** `isBlockedIp` is called with a routable public address (e.g. `93.184.216.34` or `2606:2800:220:1:248:1893:25c8:1946`)
- **THEN** it returns false

#### Scenario: The loopback exception is narrow
- **WHEN** `isBlockedIp` is called with loopback allowed
- **THEN** `127.0.0.1` and `::1` return false while `169.254.169.254` and `10.0.0.1` still return true

### Requirement: Validation-time gate handles only HTTP(S) and derives the loopback exception from structured context
`assertUrlSafe(url, options)` SHALL apply to **HTTP(S) URLs** (custom base_urls, `APPRISE_API_URL`, extracted webhook endpoints; non-HTTP Apprise schemes such as `discord://`/`tgram://` are validated by the consuming change, not here). It SHALL reject (throwing a typed `SsrfError`): non-`http(s)` schemes; an IPv6 **zone id**; `http` for any destination that is not proven-loopback (under the exception) or an allowed endpoint; and any URL whose hostname is an IP literal in — or resolves (via the injectable resolver, default DNS, **rejecting if ANY resolved address is blocked**) to — a blocked range. The loopback exception SHALL be derived **inside** the guard from `context: { mode, providerKind }` (`loopbackAllowed = mode==='selfhosted' && providerKind==='local'`), never from a raw caller boolean. An `allowedEndpoints: { host, cidr, port? }` entry SHALL trust a host **only when the resolved address is within its declared CIDR and the port matches**; an entry whose CIDR overlaps the HARD range set SHALL be **rejected at construction**, so an allowlist can relax only SOFT (RFC1918/CGNAT/ULA) space — metadata/loopback/mapped stay hard-blocked even for an allowlisted host.

#### Scenario: SSRF targets are rejected
- **WHEN** `assertUrlSafe` is given `http://169.254.169.254/latest/meta-data`, `http://localhost`, `http://10.0.0.1`, `https://[::1]`, `https://[fd00::1]`, or a mapped/NAT64 literal
- **THEN** each is rejected with an `SsrfError`

#### Scenario: A hostname resolving to a private IP is rejected, even split public/private
- **WHEN** `assertUrlSafe` is given a hostname that resolves to a private/metadata address, or to a set of addresses where at least one is private
- **THEN** it is rejected

#### Scenario: Protocol and context rules hold
- **WHEN** a `file://`/`gopher://` URL, or a plain remote `http://` URL, is validated with `context: { mode:'cloud' }`
- **THEN** it is rejected; a `https://` public URL is accepted; and `http://127.0.0.1:11434` is accepted only with `context: { mode:'selfhosted', providerKind:'local' }`

#### Scenario: Allowlisted hosts are address- and port-bounded and cannot relax the HARD set
- **WHEN** an `allowedEndpoints` host resolves inside its declared CIDR on the declared port it is accepted; **WHEN** the same host resolves outside its CIDR, on a different port, or to metadata/loopback; or **WHEN** an entry whose CIDR overlaps loopback/metadata/mapped is constructed
- **THEN** the request is rejected, or the overlapping entry is rejected at construction

### Requirement: Guarded fetch validates before connecting, rejects unsafe redirects, and never leaks credentials
`guardedFetch(url, init, options)` SHALL be the fetch-compatible transport callers use. It SHALL `assertUrlSafe` the initial URL and follow redirects **manually** (`redirect: 'manual'`, bounded by `maxRedirects`, default 5): only `301/302/303/307/308` with a valid `Location` are followed, **cross-origin redirects are rejected** (so `Authorization`/cookies/body are never forwarded to another origin), a non-replayable body aborts on redirect, and every intermediate response body is cancelled. It SHALL dispatch through a transport whose **connector resolves and validates every candidate address BEFORE `net.connect`** (rejecting blocked addresses so a private/metadata listener never receives a TCP connection or TLS ClientHello), connects to the validated IP preserving `Host`/TLS `servername`, and re-checks `remoteAddress` post-connect. `createGuardedDispatcher(options)` SHALL be the caller-owned, closeable lifecycle. Node `http`/`https` Agents SHALL NOT be relied on for `fetch` protection.

#### Scenario: Rebinding to a private address is blocked before connecting
- **WHEN** a hostname passes name-time validation (resolves public) but the connect-time resolution is a private/loopback/metadata address
- **THEN** `guardedFetch` rejects before `net.connect` and the private destination's listener accepts no connection

#### Scenario: A cross-origin or private redirect is rejected
- **WHEN** a validated URL responds `3xx` with a `Location` to a different origin, or to `http://127.0.0.1`/`http://169.254.169.254`
- **THEN** `guardedFetch` rejects (cross-origin or blocked) instead of following, forwarding no credentials

#### Scenario: A normal public fetch succeeds
- **WHEN** `guardedFetch` targets a public HTTPS URL that does not redirect to a blocked or cross-origin address
- **THEN** it returns the response

### Requirement: SSRF-rejection suite proves the acceptance criterion for HTTP(S)
The change SHALL ship a Vitest suite covering the spec §15 SSRF criterion for HTTP(S) URLs: `169.254.169.254`, `localhost`, RFC1918 ranges, their IPv6 equivalents, the IPv4-mapped/NAT64 forms, decimal/octal/hex IPv4 encodings, `0.0.0.0`, trailing-dot and userinfo tricks, and a **rebinding hostname exercised through the real socket path** (an integration test with a local listener: name-time public, connect-time loopback → request fails, listener receives nothing) are all rejected; loopback is accepted only under the selfhosted/local context. End-to-end CRUD proof (adding a provider/channel with a bad URL is rejected) is explicitly left to #7/#15.

#### Scenario: The suite runs green in the shared package
- **WHEN** `npm test -w packages/shared` runs
- **THEN** the SSRF suite passes, covering each rejection case, the encoding/parse bypasses, the socket-path rebinding integration test, and the loopback exception
