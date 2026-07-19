// add-subscription-oauth — preset invariants + token-failure classification.
import { classifyTokenFailure } from './oauth-client';
import { OAUTH_PRESETS, buildAuthorizeUrl, CLAUDE_PRESET, CHATGPT_PRESET } from './presets';

describe('preset invariants', () => {
  it('every preset baseUrl is in canonical URL form (update-path normalization equality)', () => {
    // codex round 3: the provider update path compares new URL(x).href — a
    // non-canonical preset value would 422 every name-only edit.
    for (const p of OAUTH_PRESETS) {
      expect(new URL(p.baseUrl).href).toBe(p.baseUrl);
    }
  });

  it('presets ship enabled ONLY behind a passed live verification (the enablement gate)', () => {
    // Both flipped true on 2026-07-18 after their runbooks passed live (see the
    // "VERIFIED LIVE" notes in presets.ts and scripts/verify-*-oauth.md). A NEW
    // preset must start `enabled: false` until its own runbook passes.
    expect(CLAUDE_PRESET.enabled).toBe(true);
    expect(CHATGPT_PRESET.enabled).toBe(true);
  });

  it('builds a PKCE S256 authorize URL carrying state', () => {
    const url = new URL(buildAuthorizeUrl(CLAUDE_PRESET, 'st-1', 'chal-1'));
    expect(url.searchParams.get('state')).toBe('st-1');
    expect(url.searchParams.get('code_challenge')).toBe('chal-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(CLAUDE_PRESET.redirectUri);
    // The code-display variant param survives the extraAuthorizeParams refactor.
    expect(url.searchParams.get('code')).toBe('true');
  });

  it('the ChatGPT authorize URL is standard OIDC — no Claude-specific params', () => {
    const url = new URL(buildAuthorizeUrl(CHATGPT_PRESET, 'st-2', 'chal-2'));
    expect(url.searchParams.get('code')).toBeNull(); // Claude-only variant param
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(url.searchParams.get('scope')).toContain('openid'); // id_token source
  });

  it('the ChatGPT preset pins the Responses protocol, form encoding, and a bundled probe', () => {
    expect(CHATGPT_PRESET.protocol).toBe('openai_responses');
    expect(CHATGPT_PRESET.tokenRequestEncoding).toBe('form');
    expect(CHATGPT_PRESET.modelsSource).toBe('bundled');
    // The designated probe model is the FIRST bundled model (kept coherent).
    expect(CHATGPT_PRESET.probeModel).toBe(CHATGPT_PRESET.bundledModels?.[0]);
  });

  it('pins the per-preset exchange `state` quirk (verified live 2026-07-18)', () => {
    // console.anthropic.com's exchange TAKES state; auth.openai.com 400s on the
    // unknown parameter — a guessed value bricks one preset or the other.
    expect(CLAUDE_PRESET.includeStateInExchange).toBe(true);
    expect(CHATGPT_PRESET.includeStateInExchange).toBe(false);
  });
});

describe('classifyTokenFailure (codex round 3)', () => {
  it("only an explicit RFC 6749 error:'invalid_grant' body marks the grant dead", () => {
    expect(classifyTokenFailure(400, '{"error":"invalid_grant"}')).toBe('invalid_grant');
    expect(classifyTokenFailure(401, '{"error":"invalid_grant"}')).toBe('invalid_grant');
  });

  it("recognizes auth.openai.com's NESTED error object (verified live: 401 token_expired)", () => {
    // The exact live shape observed during ChatGPT verification.
    const live =
      '{"error":{"message":"Could not validate your token. Please try signing in again.","type":"invalid_request_error","param":null,"code":"token_expired"}}';
    expect(classifyTokenFailure(401, live)).toBe('invalid_grant');
    expect(classifyTokenFailure(400, '{"error":{"code":"invalid_grant"}}')).toBe('invalid_grant');
    // Other nested codes stay transient (conservative — reauth would not fix them).
    expect(classifyTokenFailure(401, '{"error":{"code":"rate_limited"}}')).toBe('transient');
    expect(classifyTokenFailure(500, live)).toBe('transient'); // 5xx never marks the grant dead
  });

  it('other 4xx OAuth errors are transient — reauthorization would not fix them', () => {
    expect(classifyTokenFailure(400, '{"error":"invalid_request"}')).toBe('transient');
    expect(classifyTokenFailure(401, '{"error":"invalid_client"}')).toBe('transient');
    expect(classifyTokenFailure(403, '{"error":"access_denied"}')).toBe('transient');
  });

  it('malformed/hostile bodies and 5xx/429 are transient (tokens untouched)', () => {
    expect(classifyTokenFailure(400, 'not json')).toBe('transient');
    expect(classifyTokenFailure(400, '{"error":{"nested":"invalid_grant"}}')).toBe('transient');
    expect(classifyTokenFailure(429, '{"error":"invalid_grant"}')).toBe('transient');
    expect(classifyTokenFailure(500, '{"error":"invalid_grant"}')).toBe('transient');
  });
});
