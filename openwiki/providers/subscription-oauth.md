---
type: Architecture
title: Subscription OAuth
description: Connect Claude Pro/Max and ChatGPT Plus/Pro subscriptions as providers via OAuth — presets, PKCE connect flow, typed credential envelope, rotation-safe token refresh, and reauthorization semantics.
tags: [oauth, subscription, claude, chatgpt, credentials, providers]
resource: packages/control-plane/src/subscription-oauth/
---

# Subscription OAuth

Subscription OAuth lets users connect their **Claude Pro/Max** or **ChatGPT Plus/Pro** subscription as a polyrouter provider, instead of paying per-token API prices. Polyrouter performs an OAuth authorization-code flow against the first-party identity provider, stores the tokens in an encrypted typed envelope, and refreshes them automatically before expiry.

**Source**: `packages/control-plane/src/subscription-oauth/`

## How It Works

```
Dashboard (Providers page)         Control Plane                    Identity Provider
        │                                │                                 │
        │  GET /api/providers/oauth/presets                               │
        │───────────────────────────────▶│                                 │
        │  POST /api/providers/oauth/start {preset}                       │
        │───────────────────────────────▶│ mint PKCE + state, store        │
        │                                │ connect session in Redis        │
        │ ◀── {sessionId, authorizeUrl} ─│                                 │
        │                                │                                 │
        │  User signs in at claude.ai / auth.openai.com, copies redirect  │
        │                                │                                 │
        │  POST /api/providers/oauth/complete {sessionId, pasted}         │
        │───────────────────────────────▶│ verify state → exchange code ──▶│
        │                                │ ◀── access/refresh tokens ──────│
        │                                │ encrypt envelope → insert       │
        │                                │ provider row (kind=subscription)│
        │ ◀────────── provider ──────────│                                 │
```

The "paste" variant is used because both presets use a **code-display redirect**: the identity provider shows `code#state` on a page for manual copy instead of redirecting to a local server.

**Source**: `subscription-oauth.controller.ts`, `subscription-oauth.service.ts`

## Presets

Presets are fixed, bundled constants — never user input — so the OAuth surface adds no new SSRF risk. Each preset pins the base URL, protocol, authorize/token endpoints, public client ID, scopes, redirect URI, and token-request encoding quirks.

| Preset | Display Name | Protocol | Models Source | Notes |
|--------|-------------|----------|---------------|-------|
| `claude` | Claude Pro / Max | `anthropic_compatible` | endpoint (`/v1/models` with OAuth token) | Requires `anthropic-beta: oauth-2025-04-20` header; token exchange takes JSON with `state` in body |
| `chatgpt` | ChatGPT Plus / Pro | `openai_responses` | bundled (no models endpoint) | Sends `chatgpt-account-id` header (captured from exchange `id_token`); probe model validates connection |

A preset ships `enabled: false` until a live golden verification passes (`scripts/verify-claude-oauth.md`, `scripts/verify-chatgpt-oauth.md`).

**Source**: `packages/control-plane/src/subscription-oauth/presets.ts`

## Connect Session Security

- **PKCE** — every session mints a fresh verifier/challenge pair
- **Single-use** — sessions are claimed atomically (consumed pre-exchange) with a TTL in Redis
- **Bound to principal AND login session** — completion must come from the same user and the same browser session (hashed session-cookie key) that started the flow; all failures return the same fixed message (no oracle)
- **Rate limited** — per-IP rule on `/api/providers/oauth/**` plus per-principal rule (10/min)
- **`Cache-Control: no-store`** — connect responses reference credential-bearing flows

**Source**: `connect-sessions.ts`, `paste.ts`, `account-claim.ts`

## Credential Envelope

OAuth tokens are stored inside the provider row's `encrypted_credentials` column as a **typed envelope** (`polycred:v1:` + JSON), encrypted with the same AES-256-GCM `PROVIDER_CREDENTIAL_KEY` as plain API keys. The envelope carries the preset id, access token, refresh token, expiry, and (for ChatGPT) the account id. Legacy rows hold raw strings and read as `kind: 'plain'`.

See [Security & Auth](/openwiki/security/auth.md#credential-envelope) for the envelope format and tamper handling, and [Data Model](/openwiki/data-model/schema.md) for the non-secret provider columns (`oauth_preset`, `credential_expires_at`, `credential_error`).

## Token Refresh & Rotation Safety

Credential resolution happens at adapter-build time, on every proxied request:

1. **Cheap path** — if the access token is more than 5 minutes from expiry, decrypt and return it
2. **Backoff** — after a transient identity-provider failure, a 30s Redis backoff key prevents re-dial storms; the still-valid token is served
3. **Single-flight** — at most one refresh per provider per instance (`inflight` map)
4. **Advisory lock** — the refresh transaction takes a per-provider advisory lock (`credentialLockKey`), re-reads the envelope inside the lock, and persists the rotated tokens there. PATCH credential edits and reauthorize completions serialize on the **same** lock, so a refresh can never clobber or resurrect a concurrent user mutation
5. **Rotation-safe** — refresh tokens rotate; the locked re-read ensures the refresh is based on the newest envelope

Refresh is **pre-request only**. A `credential`-kind failure is fallback-eligible and breaker-neutral.

**Source**: `subscription-oauth.service.ts` (`resolveCredential`, `refreshFlight`)

## Reauthorization vs Refresh

| | Ordinary refresh | Reauthorization |
|---|---|---|
| Trigger | Token near expiry, automatic | User clicks "Reconnect" in dashboard |
| Breaker | **Never reset** — preserves genuine upstream failure history | **Reset** — the freshly reconnected provider must not serve a cooldown earned by its dead credential |
| Failure mode | Transient → serve old token with backoff; durable → persist `credential_error: 'reauthorize_required'` | New full OAuth connect flow bound to the existing provider row |

When `credential_error` is set, credential resolution fails locally with a fixed message — the identity provider is never re-probed per request. The dashboard reads this column to show a "Reconnect" action.

**Source**: `subscription-oauth.service.ts` (`persistCredentialError`, breaker reset on reauthorize)

## Wire Protocol Effects

OAuth-connected providers use different auth headers than API-key providers (see [Provider Adapters](/openwiki/providers/adapters.md)):

- **Claude** (`anthropic_compatible`) — `Authorization: Bearer <access-token>` + `anthropic-beta: oauth-2025-04-20`; **no** `x-api-key`
- **ChatGPT** (`openai_responses`) — `Authorization: Bearer` + `chatgpt-account-id` + `responses=experimental` beta header; **no** `x-api-key`, no client fingerprints or imitation `instructions` (no-spoofing rule)

The ChatGPT backend only accepts streaming requests, so the Responses adapter implements `chat()` as stream-and-collect over the SSE wire.

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /api/providers/oauth/presets` | List enabled presets (id + display name) |
| `POST /api/providers/oauth/start` | Begin connect — returns `{sessionId, authorizeUrl}` |
| `POST /api/providers/oauth/complete` | Finish connect — verifies state, exchanges code, writes provider |
| `POST /api/providers/oauth/reauthorize/:id` | Begin reconnect for an existing OAuth provider (preset derived from the row, never swapped) |

## Testing

- Unit: `oauth-client.spec.ts`, `presets.spec.ts`, `paste.spec.ts`, `subscription-oauth.service.spec.ts` (control-plane); `oauth-scheme.spec.ts`, `attribution.spec.ts`, `responses-adapter.spec.ts` (data-plane); `credential-envelope.test.ts` (shared)
- E2E: `packages/control-plane/test/subscription-oauth/oauth-connect.e2e-spec.ts`
- Live verification runbooks: `scripts/verify-claude-oauth.md`, `scripts/verify-chatgpt-oauth.md`; `scripts/force-oauth-refresh.mjs` forces a refresh rotation
