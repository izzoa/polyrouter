## Context

Three narrow defense-in-depth items, each behind an existing guard, so all are behavior-preserving for
valid inputs.

## Decisions

- **A-40:** `encryptSecret` always emits a 16-byte GCM tag, so on decrypt any other length is a
  tampered/malformed envelope. Reject inside the existing `try`, so the fixed secret-free "decryption
  failed" message is what surfaces (no new failure mode is exposed).
- **A-41:** `assertEndpointsSafe` now classifies BOTH the network and broadcast of the CIDR **for either
  family** (via `cidrRange`, BigInt math), rejecting a short-prefix soft-network CIDR whose range spans a
  hard/public block — e.g. `10.0.0.0/7` (→ `11.x` public) or `fc00::/6` (→ hard `fe80::/10`, `ff00::/8`).
  (An earlier revision checked IPv6 by network address only; codex round 1 caught that `fc00::/6` slips
  through, so v6 is now full-range too.) It throws `SsrfError` (not a plain Error) so every caller
  classifies it uniformly — the SMTP adapter maps it to `smtp_host_blocked` rather than mis-diagnosing a
  bad allowlist as `smtp_unresolvable`. It is exported and called at the top of `assertNetworkHostSafe`,
  so the notification path validates its allowlist with the same policy as the URL path — the runtime
  guard (`isAddressPermitted` rejects hard IPs first) already blocked the addresses, so this only tightens
  *config validation* (rejecting a bad allowlist entry early).
- **A-43:** a latched `error` handler (one line per outage, reset on `ready`) prevents ioredis from
  emitting an "Unhandled error event" per reconnect. It logs ONLY the error's syscall `code`/class name —
  never `err.message` (which can carry the endpoint/credentials/server text), invariant 8. The logic is
  extracted to a testable `installRedisErrorLog` and unit-tested for latch, `ready` reset, and message
  redaction.

## Risks / Trade-offs

- Validating the allowlist on every notification egress re-runs an O(n) check per send; n is tiny (a few
  operator-configured entries), negligible.
- The IPv6 range is validated by network address only (documented) — acceptable given v6 soft/hard range
  topology.

## Migration Plan

None — behavior-preserving for valid inputs; no schema/API change.
