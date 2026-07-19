/**
 * Bundled OAuth presets (add-subscription-oauth). Every URL/id here is a FIXED
 * constant — never user input (no new SSRF surface; exchanges still flow through the
 * guarded fetch as defense-in-depth). Model sourcing is DECLARED per preset, never a
 * runtime fallback that could mask an auth failure.
 *
 * The Claude constants are ecosystem-known (Claude Code's public OAuth client), not a
 * documented contract — they are verify-at-implementation, and the preset ships
 * `enabled: false` until the live golden verification (tasks 7.2) passes. polyrouter
 * sends only the documented/ecosystem headers (Bearer + anthropic-beta) and never
 * imitates the first-party client beyond them (no-spoofing rule).
 */

export type ModelsSource = 'endpoint' | 'bundled';

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
  readonly modelsSource: ModelsSource;
  /** Bundled model ids, used only when modelsSource === 'bundled'. */
  readonly bundledModels?: readonly string[];
  /** The designated validating-probe model for a models-endpoint-less protocol —
   * the FIRST bundled model; threaded to the adapter as trusted registry data. */
  readonly probeModel?: string;
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
  modelsSource: 'endpoint',
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
 * + that beta header — never `originator`/session fingerprints or imitation
 * instructions (no-spoofing rule).
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
  modelsSource: 'bundled',
  // VERIFIED LIVE 2026-07-18 against the backend's own allowlist (the gpt-5.x ids
  // from ecosystem knowledge were rejected). First entry doubles as the designated
  // probe model — the cheapest of the set. `codex-auto-review` exists upstream but
  // is purpose-built for Codex's review feature and deliberately not bundled.
  bundledModels: ['gpt-5.4-mini', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4'],
  probeModel: 'gpt-5.4-mini', // the first bundled model — the designated probe target
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
