---
'@polyrouter/shared': patch
'@polyrouter/control-plane': patch
---

Security/robustness defense-in-depth (FABLE_AUDIT A-40/A-41/A-43): pin the AES-256-GCM auth tag to the full 16 bytes on decrypt (reject a truncated tag, which would weaken forgery resistance); validate an SSRF allowlist CIDR over its **full range** for both IPv4 and IPv6 (a soft-network CIDR whose range spans a hard/public block — e.g. `10.0.0.0/7` or `fc00::/6` — is now rejected, with strict CIDR grammar), run that validation on the notification host path too, and surface it as a typed SSRF error; and attach a latched `error` listener to the shared Redis client so an outage logs one class-only line (never `err.message`) instead of flooding with "Unhandled error event". Behavior-preserving for valid inputs.
