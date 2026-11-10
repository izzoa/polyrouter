/**
 * Bundled OAuth presets (add-subscription-oauth). Every URL/id here is a FIXED
 * constant — never user input (no new SSRF surface; exchanges still flow through the
 * guarded fetch as defense-in-depth). A preset carries NO model id
 * (add-live-subscription-models): every preset's models come from its provider's own
 * authenticated listing, and Test is that listing — so an upstream model retirement
 * can never make a preset stale.
 *
 * The Claude constants are ecosystem-known (Claude Code's public OAuth client), not a
 * documented contract — they are verify-at-implementation, and the preset ships
 * `enabled: false` until the live golden verification (tasks 7.2) passes. polyrouter
 * sends only the documented/ecosystem headers (Bearer + anthropic-beta); this preset
 * declares no client identity.
 */

import type { PlanUsageDialect, PlanUsageProbe } from '@polyrouter/data-plane';
import type { PresetClientIdentity } from '../providers/client-identity';

export interface OauthPreset {
  readonly id: string;
  readonly displayName: string;
  /** Pinned provider config — the wizard creates the row with exactly these. MUST be
   * the canonical `new URL(x).href` form (enforced by a unit test) so update-path
   * normalization compares equal. */
  readonly baseUrl: string;
  readonly protocol: 'openai_compatible' | 'anthropic_compatible' | 'openai_responses';
  readonly authorizeUrl: string;
  readonly tokenEndpoint: string;
  /** PUBLIC OAuth client id of the first-party app (a public identifier, not a secret). */
  readonly clientId: string;
  readonly scopes: string;
  readonly redirectUri: string;
  /** Extra authorize-URL params a preset's IdP requires (e.g. Claude's `code=true`
   * code-display variant). Fixed constants — never user input. */
  readonly extraAuthorizeParams?: Readonly<Record<string, string>>;
  /** Token-endpoint body encoding (add-chatgpt-responses): Claude's endpoint takes
   * JSON; auth.openai.com takes form-urlencoded. */
  readonly tokenRequestEncoding: 'json' | 'form';
  /** Whether the authorization-code exchange body carries `state` (non-standard —
   * RFC 6749 token requests omit it). VERIFIED LIVE: console.anthropic.com's exchange
   * takes it (the Claude Code shape); auth.openai.com rejects ANY unknown parameter
   * with `400 unknown_parameter` — so this is preset-declared, never guessed. */
  readonly includeStateInExchange: boolean;
  /** The `anthropic-beta` value OAuth tokens require (threaded to the adapter). */
  readonly oauthBeta?: string;
  /** Fixed, bundled client-identity headers this preset may send, only while the
   * provider's per-row switch is on (allow-preset-client-identity). Claude and ChatGPT
   * declare none. Validated by `validateClientIdentity()`; never user input. */
  readonly clientIdentity?: PresetClientIdentity;
  /** The wire format of the plan-usage metadata this preset's replies carry
   * (add-subscription-quota-display, design D1). Trusted routing data, never user input and never
   * part of the available-presets DTO. It reaches an adapter only through `planUsageSourcesFor`,
   * i.e. only for a row still pinned to this preset's endpoint. */
  readonly usageDialect?: PlanUsageDialect;
  /** The preset's plan-usage endpoint (add-subscription-usage-history, design D2): a fixed `https`
   * constant on the origin of `baseUrl`, read by Refresh usage and the 15-minute usage schedule
   * with polyrouter's own User-Agent, the row's OAuth Bearer token and only the extra headers it
   * names from the data plane's closed allowlist. Trusted routing data, never user input and
   * never part of the available-presets DTO; reached only through `planUsageSourcesFor`. */
  readonly usageProbe?: PlanUsageProbe;
  /** Enablement gate: flipped to true ONLY after the live golden verification passes
   * (an enabled-and-known-broken preset must not ship). */
  readonly enabled: boolean;
}

export const CLAUDE_PRESET: OauthPreset = {
  id: 'claude',
  displayName: 'Claude Pro / Max',
  // CANONICAL URL form (new URL(x).href — trailing slash): the provider update path
  // normalizes to href before comparing, so a non-canonical preset value would make
  // every name-only PATCH look like endpoint drift and 422 (codex round 3).
  baseUrl: 'https://api.anthropic.com/',
  protocol: 'anthropic_compatible',
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  tokenEndpoint: 'https://console.anthropic.com/v1/oauth/token',
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  scopes: 'user:profile user:inference',
  // The code-display callback variant: the page shows `code#state` for manual copy.
  redirectUri: 'https://console.anthropic.com/oauth/code/callback',
  // `code=true` selects the code-display authorize variant (Claude-specific).
  extraAuthorizeParams: { code: 'true' },
  tokenRequestEncoding: 'json',
  includeStateInExchange: true, // verified live 2026-07-18: the exchange succeeds with it
  oauthBeta: 'oauth-2025-04-20',
  // Passive: the `anthropic-ratelimit-unified-*` header family, read off ordinary replies.
  usageDialect: 'anthropic_unified',
  // Active (add-subscription-usage-history): Claude Code's `/usage` endpoint, the PLAIN path only
  // (never a `?cedar_ember` / `skip_spend` variant, which return grant inventories). Bearer + the
  // OAuth beta the endpoint requires; never `/api/oauth/profile`. Ships enabled (design D3); its
  // acceptance of polyrouter's honest User-Agent is optional QA (scripts/verify-plan-usage.md).
  usageProbe: {
    url: 'https://api.anthropic.com/api/oauth/usage',
    auth: 'bearer',
    parser: 'claude_oauth_usage',
    enabled: true,
    extraHeaders: ['anthropic-beta'],
  },
  // VERIFIED LIVE 2026-07-18 (scripts/verify-claude-oauth.md): connect + paste,
  // OAuth /v1/models (10 models), and a real forced refresh all pass. The proxied
  // completion returned the account's own usage-window 429 (surfaced typed) — an
  // account condition, not an integration failure.
  enabled: true,
};

/**
 * ChatGPT Plus/Pro via the Codex-backend Responses API (add-chatgpt-responses). The
 * constants are ecosystem-known (Codex CLI's public OAuth client), not a documented
 * contract — verify-at-implementation; ships `enabled: false` until the live golden
 * verification (`scripts/verify-chatgpt-oauth.md`) passes. The Responses beta header
 * itself is pinned INSIDE the openai_responses provider adapter (protocol-intrinsic,
 * a bundled constant either way). polyrouter sends ONLY Bearer + `chatgpt-account-id`
 * + that beta header; this preset declares no client identity.
 */
export const CHATGPT_PRESET: OauthPreset = {
  id: 'chatgpt',
  displayName: 'ChatGPT Plus / Pro',
  // CANONICAL href (trailing slash) — same name-only-edit invariant as Claude.
  baseUrl: 'https://chatgpt.com/',
  protocol: 'openai_responses',
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  tokenEndpoint: 'https://auth.openai.com/oauth/token',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  scopes: 'openid profile email offline_access',
  // Dead-tab localhost redirect: the browser shows an unreachable-page error while the
  // address bar carries `?code=…&state=…` — the user pastes that URL (query parse,
  // state REQUIRED — the SO-1 parser handles it unchanged).
  redirectUri: 'http://localhost:1455/auth/callback',
  tokenRequestEncoding: 'form',
  // Verified live 2026-07-18: auth.openai.com 400s (`unknown_parameter: state`) on a
  // state-bearing exchange body — the param must be OMITTED for this preset.
  includeStateInExchange: false,
  // Passive: the `x-codex-*` rate-limit header family, read off ordinary replies.
  usageDialect: 'codex',
  // Active (add-subscription-usage-history): Codex's usage endpoint. Bearer + the row's own
  // `chatgpt-account-id`; never `originator`, never `x-openai-codex-luna-reserve`, and never any
  // other `/wham/` path (`/wham/rate-limit-reset-credits*` MUTATES; `/wham/profiles/me` and
  // `/wham/accounts/…` are personal data). Ships enabled (design D3, FD2/FD3).
  usageProbe: {
    url: 'https://chatgpt.com/backend-api/wham/usage',
    auth: 'bearer',
    parser: 'chatgpt_wham_usage',
    enabled: true,
    extraHeaders: ['chatgpt-account-id'],
  },
  // No bundled model list and no probe model (add-live-subscription-models): the
  // Responses adapter lists the backend's own catalog (verified live 2026-09-24) and
  // Test is that listing. The July bundle's probe model `gpt-5.4-mini` was retired
  // 2026-09-22 and turned every Test red — the reason no preset names a model.
  // VERIFIED LIVE 2026-07-18 (scripts/verify-chatgpt-oauth.md): connect + account-id
  // claim, buffered + streamed completions, live tool calling, and a real forced
  // refresh (account id retained) all pass with ONLY the three documented headers.
  enabled: true,
};

export const OAUTH_PRESETS: readonly OauthPreset[] = [CLAUDE_PRESET, CHATGPT_PRESET];

export function findPreset(id: string): OauthPreset | undefined {
  return OAUTH_PRESETS.find((p) => p.id === id);
}

/** The authorize URL for a connect session (PKCE S256 + state). */
export function buildAuthorizeUrl(preset: OauthPreset, state: string, challenge: string): string {
  const u = new URL(preset.authorizeUrl);
  for (const [k, v] of Object.entries(preset.extraAuthorizeParams ?? {})) {
    u.searchParams.set(k, v);
  }
  u.searchParams.set('client_id', preset.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', preset.redirectUri);
  u.searchParams.set('scope', preset.scopes);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  return u.toString();
}
