---
'@polyrouter/frontend': patch
---

Fix four dashboard correctness/UX defects (FABLE_AUDIT epic E12):

- **A mid-session 401 now re-gates to login.** 401 was handled only during bootstrap; after the SPA reached the ready state, an expired session left every action failing with an unexplained "Unauthorized" and the poll painting a permanent, unretryable banner. A shared error funnel now re-probes `/api/me` (transitioning to the login gate, reloading login-config) on any `401` received while ready.
- **Copy no longer claims success when the clipboard write failed.** On a non-secure origin (self-host over plain http on a LAN IP) `navigator.clipboard` is undefined; the UI still toasted "Key copied", so a user dismissed the one-time key reveal and lost the key. The clipboard write is now authoritative — a missing API or a rejected write shows a distinct "Copy failed — select the text manually", never a false success.
- **The displayed/copied endpoint follows the serving origin.** The endpoint chip, Settings "Endpoint", the Agents instructions, the sidebar footer, and the `snippetFor` fallback derived from a hardcoded `http://127.0.0.1:3001/v1`, contradicting the server-minted snippet on any non-default host. They now derive from `${location.origin}/v1` (same-origin serving makes this correct in prod and consistent with the snippet).
- **The setup guide no longer wipes an existing default-tier chain.** The always-available guide unconditionally full-replaced `default` with a single model, silently destroying a configured `[primary, …fallbacks]` chain. It now reads the tier first: full-replace only when empty, otherwise append the new model (preserving the existing primary and fallbacks), no-op when already routed, and — when the tier is already full — surface a "tier full" message instead of a phantom assignment. A single-flight guard also prevents a double-click from minting a duplicate provider.

Frontend-only; no API or schema change. (Cross-tab tier-write atomicity and a bootstrap-window 401 re-probe are documented residuals deferred to backlog.)
