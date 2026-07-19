# Live verification — ChatGPT Plus/Pro OAuth preset (add-chatgpt-responses)

The ChatGPT preset's constants are **ecosystem-known (Codex CLI's public OAuth client),
not documented contracts** (`packages/control-plane/src/subscription-oauth/presets.ts`),
and the `openai_responses` wire shapes are golden-pinned from the same ecosystem knowledge
(`packages/data-plane/src/proxy/translate/responses.ts`). Per the spec, the preset ships
**`enabled: false`** until this check passes against a real ChatGPT Plus/Pro account — an
enabled-and-known-broken preset must never ship. Re-run on suspicion of upstream drift.

Needs: a ChatGPT Plus or Pro account, a running polyrouter dev stack (`npm run dev` +
`docker compose -f docker-compose.dev.yml up -d`), ~10 minutes.

**The no-spoofing rule governs every step:** polyrouter sends ONLY
`Authorization: Bearer` + `chatgpt-account-id` + `OpenAI-Beta: responses=experimental`.
**If acceptance turns out to require client-fingerprint headers (`originator`, session
ids) or imitation `instructions` content — STOP.** The preset stays disabled and the
limitation gets documented; polyrouter never forces acceptance by impersonation.

## 1. Temporarily enable the preset

In `presets.ts`, flip `CHATGPT_PRESET.enabled` to `true` (local working copy only) and
restart.

## 2. Connect end-to-end

1. Dashboard → Providers → Add provider → **Subscription** → the **ChatGPT Plus / Pro** card.
2. Open the sign-in link; approve. Expected: an auth.openai.com authorize page for the
   Codex client; after approval the browser lands on a **dead `localhost:1455` tab**
   (unreachable-page error) whose address bar carries `?code=…&state=…`.
3. Paste that full URL back; the card should show **Connected · auto-refreshes**.

Record and pin back into the code/goldens if they differ:

- the authorize/token URLs actually used (`authorizeUrl`, `tokenEndpoint`);
- whether the token exchange demanded `application/x-www-form-urlencoded`
  (`tokenRequestEncoding: 'form'`) and whether the id_token claim path is
  `payload["https://api.openai.com/auth"].chatgpt_account_id` (account-claim extraction);
- `expires_in` (from `credential_expires_at` in the DB vs the connect time).

## 3. One proxied completion (the wire goldens' live check)

Sync models (should seed the **bundled** list), route a tier at a ChatGPT model on this
provider, and send one `/v1/chat/completions` request with an agent key. Expected: a
normal completion, and a streamed request delivers deltas.

Verify/record against the pinned constants:

- the chat path (`/backend-api/codex/responses`) and the beta header value
  (`responses=experimental`) are accepted;
- the **bundled model ids** (`gpt-5`, `gpt-5-codex`) are real — fix the preset's
  `bundledModels`/`probeModel` to the verified list if not;
- `max_output_tokens`, `store: false`, and the `input`/`instructions` request fields are
  accepted as pinned in `translate/responses.ts` (a 4xx naming a field means the golden
  files need the verified name);
- tool calling round-trips (`function_call`/`function_call_output` with `call_id`).

If the backend rejects OAuth-authenticated requests in a way that implies required
impersonation — see the STOP rule above.

## 4. One forced refresh

The resolver reads expiry from the **encrypted envelope** — editing the display column
alone forces nothing. Rewind the authoritative envelope with the (preset-agnostic) helper:

```sh
DATABASE_URL=… PROVIDER_CREDENTIAL_KEY=… \
  node scripts/force-oauth-refresh.mjs <provider-id>
```

then send another request (or Test). Expected: it succeeds and `credential_expires_at`
jumps forward. **Record whether auth.openai.com rotates the refresh token or omits it** —
both are supported (an omitted `refresh_token` retains the stored one), but the observed
behavior belongs in this file. Verify the account id survived the refresh (reconnect is
NOT needed; the row keeps working). Also verify the revoked path once: revoke the Codex
app's access from the ChatGPT account settings, run the helper again, send a request →
the card shows **reauthorize required** (no repeated IdP calls in the logs); reconnect
restores it.

## 5. Ship it

All checks pass → flip `CHATGPT_PRESET.enabled` to `true` for real, update this file's
"verified on" line, and commit both together.

Verified on: **2026-07-18**, against a real ChatGPT account (dev stack, Node 24).
All steps passed: connect + nested account-id claim, buffered + streamed proxied
completions (`/v1/chat/completions`, plain and `stream:true`), live tool calling
(`function_call` lifecycle), bundled sync, and a real forced refresh with the account
id retained. **Only the three documented headers were needed** — no `originator`, no
session fingerprints, no imitation instructions (the no-spoofing rule holds).

### Findings pinned back into the code during this run

- **Token exchange:** `auth.openai.com` rejects a `state` param in the token body
  (`400 unknown_parameter`) → `includeStateInExchange: false` (Claude's endpoint
  wants it — per-preset field). Errors come as a NESTED object
  (`{"error":{"code":"token_expired",…}}`) → `classifyTokenFailure` recognizes it
  (`token_expired`/nested `invalid_grant` = dead grant). The token client pins
  `Accept-Encoding: identity` (a zstd-compressed IdP response crashed Node < 23.8's
  undici — and the dev stack must run the engines-pinned Node 24).
- **The Responses wire is STREAMING-ONLY** ("Stream must be set to true") — buffered
  `chat()` is stream-and-collect. It **rejects** `max_output_tokens`, `temperature`,
  and `top_p` ("Unsupported parameter") — all three are documented drops; token caps
  cannot be enforced upstream on this backend.
- **Model allowlist (live):** `gpt-5.4-mini`, `gpt-5.6-sol`, `gpt-5.6-terra`,
  `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4` (plus a purpose-built `codex-auto-review`,
  deliberately not bundled). The ecosystem-guessed `gpt-5`/`gpt-5-codex` ids were
  rejected. A models endpoint EXISTS (`GET /backend-api/codex/models?client_version=…`)
  but requires a client-version identifier — left unused (bundled sourcing) per the
  no-fingerprint stance; revisit if the bundled list drifts.
- Event names, `store:false`, `instructions`, tools/`tool_choice`/`parallel_tool_calls`,
  and the usage shape (incl. `input_tokens_details.cached_tokens`) all matched the
  golden files; extra `response.in_progress`/`response.content_part.*` events fall
  into the documented skip rule.
