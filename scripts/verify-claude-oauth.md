# Live verification — Claude Pro/Max OAuth preset (add-subscription-oauth)

The Claude preset's endpoints/headers are **ecosystem-known, not documented contracts**
(`packages/control-plane/src/subscription-oauth/presets.ts`). Per the spec, the preset ships
**`enabled: false`** until this check passes against a real Claude Pro/Max account — an
enabled-and-known-broken preset must never ship. Re-run on suspicion of upstream drift.

Needs: a Claude Pro or Max account, a running polyrouter dev stack (`npm run dev` +
`docker compose -f docker-compose.dev.yml up -d`), ~10 minutes.

## 1. Temporarily enable the preset

In `presets.ts`, flip `CLAUDE_PRESET.enabled` to `true` (local working copy only) and restart.

## 2. Connect end-to-end

1. Dashboard → Providers → Add provider → **Subscription** → the **Claude Pro / Max** card.
2. Open the sign-in link; approve. Expected: claude.ai authorize page for the "Claude Code"
   client; after approval the callback page **displays a `code#state` string**.
3. Paste it back; the card should show **Connected · auto-refreshes · expires in _N_ h**.

Record: the authorize URL actually used, the callback page's behavior, and `expires_in`
(from `credential_expires_at` in the DB vs the connect time).

## 3. One proxied completion

Route a tier at a Claude model on this provider and send one `/v1/messages` request with an
agent key. Expected: a normal completion. **If the API rejects the request in a way that
implies the request must imitate Claude Code beyond the documented headers (`Authorization:
Bearer` + `anthropic-beta`), STOP — the no-spoofing rule applies: the preset stays disabled
and the limitation gets documented instead.** Check whether `/v1/models` works under the
OAuth token; if it does not, change the preset to `modelsSource: 'bundled'` and populate its
`bundledModels` (the designated cheap validating call becomes the test path).

## 4. One forced refresh

The resolver reads expiry from the **encrypted envelope** — editing the display column alone
forces nothing. Rewind the authoritative envelope with the helper:

```sh
DATABASE_URL=… PROVIDER_CREDENTIAL_KEY=… \
  node scripts/force-oauth-refresh.mjs <provider-id>
```

then send another request (or Test). Expected: it succeeds, `credential_expires_at` jumps
forward, and the refresh token **rotated** (re-run the helper's read via
`SELECT credential_expires_at FROM provider …`; the exchange appears in the IdP's app
activity). Also verify the revoked path once: revoke access from the Claude account
settings, run the helper again, send a request → the card shows **reauthorize required**
(and no repeated IdP calls in the logs); reconnect restores it.

## 5. Ship the enablement

On a fully passing run: keep `enabled: true`, update the constants in `presets.ts` with
anything that drifted (record the verification date in its comment), and commit. On any
failure: revert to `enabled: false` and document the failure here.

| Date | Result | Notes |
|---|---|---|
| 2026-07-18 | **pass** (completion pending account quota) | Real Claude Pro/Max account, dev stack on Node 24. Connect via the `code#state` page ✓ (the exchange CARRIES `state` in its JSON body — now the per-preset `includeStateInExchange: true`); OAuth `/v1/models` works (10 models — `modelsSource: 'endpoint'` confirmed); test-connection ✓; a real forced refresh rotated the envelope and jumped `credential_expires_at` ✓ (8h access tokens). The proxied completion returned the account's own usage-window `429` — surfaced as a typed `rate_limit_error`, which is the correct behavior; re-run one completion when the account window resets. Environment finding: the token client now pins `Accept-Encoding: identity` after a zstd-encoded IdP response crashed undici on Node 22 (dev must run the engines-pinned Node 24). |
