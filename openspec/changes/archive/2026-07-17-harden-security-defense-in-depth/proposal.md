## Why

Three defense-in-depth security/robustness backlog items (FABLE_AUDIT A-40, A-41, A-43). None is an
exploitable hole today (each sits behind an existing guard), but each removes a latent weakness or
noise source.

- **A-40** `decryptSecret` calls `setAuthTag` with whatever length the envelope carries. AES-GCM accepts
  4–16-byte tags, and a truncated tag weakens forgery resistance; the encryptor always emits 16, so any
  other length is a tampered/malformed envelope that should be rejected.
- **A-41** The allowlist HARD-overlap guard (`assertEndpointsSafe`) validated only the CIDR's **network**
  address and ran only on the provider/URL path — not the notification host path. A short-prefix CIDR
  whose network is private but whose range spans a hard block (e.g. `10.0.0.0/1` covering loopback
  `127/8`) passed validation, and the notification path never validated its allowlist at all. (The
  runtime guard already blocks hard IPs, so this is config-validation defense-in-depth.)
- **A-43** The shared Redis client has no `error` listener, so ioredis logs "Unhandled error event" on
  every reconnect attempt during an outage — log flooding, and a latent EventEmitter crash risk.

## What Changes

- **A-40** Pin the GCM auth tag to 16 bytes on decrypt — a shorter/other-length tag rejects with the
  same fixed, secret-free "decryption failed" message.
- **A-41** Tighten `assertEndpointsSafe` to check the **full IPv4 range** (network + broadcast), and run
  it on the notification host path too (`assertNetworkHostSafe`) so a hard-overlapping/malformed
  allowlist entry is rejected there with the same policy as the URL path — bringing the code into line
  with the existing "same policy shape as the provider guard" requirement.
- **A-43** Attach a latched (`once-per-outage`), class-only `error` listener to the Redis client
  (reset on `ready`); never log the URL/credentials.

## Capabilities

### Modified Capabilities

- `provider-management`: at-rest secret decryption pins the GCM tag to 16 bytes (a truncated tag is
  rejected).
- `redis-wiring`: the shared Redis client attaches an `error` listener so an outage cannot flood logs
  with unhandled-error events.

## Impact

- **Code:** `shared/security/encryption.ts` (tag length), `shared/security/ssrf.ts`
  (`assertEndpointsSafe` full-range check + export), `shared/security/network-host.ts` (validate the
  allowlist on the notification path), `control-plane/redis/redis.module.ts` (error listener). No schema
  change.
- **Tests:** shared — a truncated-tag envelope rejects; a soft-network `/1` CIDR spanning loopback
  rejects; the notification path rejects a hard-overlapping allowlist entry. No changeset (internal
  hardening; behavior-preserving for valid inputs).
