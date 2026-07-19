// add-chatgpt-responses — token-client extensions: preset-declared body encoding,
// exchange-only id_token surfacing, refresh-omission tolerance, fixed-message
// failures (hostile bodies never leak — invariant 8).
import { TokenEndpointError, buildTokenRequest, parseTokenSet } from './oauth-client';
import { extractChatgptAccountId, AccountClaimError } from './account-claim';

const NOW = 1_750_000_000_000;

const base = {
  tokenEndpoint: 'https://idp.example/token',
  clientId: 'client-1',
  mode: 'selfhosted' as const,
  body: { grant_type: 'authorization_code', code: 'c0de', redirect_uri: 'https://cb.example' },
};

describe('buildTokenRequest — the preset-declared encoding contract', () => {
  it('json (default — SO-1 Claude behavior byte-identical)', () => {
    const out = buildTokenRequest(base);
    expect(out.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(out.body)).toEqual({
      grant_type: 'authorization_code',
      code: 'c0de',
      redirect_uri: 'https://cb.example',
      client_id: 'client-1',
    });
  });

  it('form (auth.openai.com): exact urlencoded body', () => {
    const out = buildTokenRequest({ ...base, encoding: 'form' });
    expect(out.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(out.body).toBe(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'c0de',
        redirect_uri: 'https://cb.example',
        client_id: 'client-1',
      }).toString(),
    );
  });

  it('pins Accept-Encoding: identity (live-verification finding: an undecodable compressed IdP response must be impossible)', () => {
    expect(buildTokenRequest(base).headers['Accept-Encoding']).toBe('identity');
    expect(buildTokenRequest({ ...base, encoding: 'form' }).headers['Accept-Encoding']).toBe(
      'identity',
    );
  });
});

describe('parseTokenSet — grant-aware requirements', () => {
  const ok = { access_token: 'at', refresh_token: 'rt', expires_in: 600 };

  it('exchange REQUIRES refresh_token and surfaces id_token', () => {
    const t = parseTokenSet(JSON.stringify({ ...ok, id_token: 'h.p.s' }), NOW, 'exchange');
    expect(t).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: NOW + 600_000,
      idToken: 'h.p.s',
    });
    expect(() =>
      parseTokenSet(JSON.stringify({ access_token: 'at', expires_in: 600 }), NOW, 'exchange'),
    ).toThrow(TokenEndpointError);
  });

  it('refresh tolerates an omitted refresh_token (caller retains) and IGNORES id_token', () => {
    const t = parseTokenSet(
      JSON.stringify({ access_token: 'at2', expires_in: 600, id_token: 'h.p.s' }),
      NOW,
      'refresh',
    );
    expect(t).toEqual({ accessToken: 'at2', expiresAt: NOW + 600_000 });
    // A rotating endpoint's refresh still carries the new token through.
    const rotated = parseTokenSet(JSON.stringify(ok), NOW, 'refresh');
    expect(rotated.refreshToken).toBe('rt');
  });

  it('hostile bodies fail with the FIXED message — content never leaks', () => {
    for (const hostile of ['not json', '[]', '{"access_token":""}', '{"evil":"<script>"}']) {
      try {
        parseTokenSet(hostile, NOW, 'refresh');
        throw new Error('expected TokenEndpointError');
      } catch (err) {
        expect(err).toBeInstanceOf(TokenEndpointError);
        expect((err as Error).message).toBe('oauth token endpoint unavailable');
      }
    }
  });
});

describe('extractChatgptAccountId — the nested-claim matrix', () => {
  const b64 = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const jwt = (payload: unknown): string => `${b64({ alg: 'RS256' })}.${b64(payload)}.sig`;
  const valid = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123_x.y' } };

  it('extracts a valid nested claim', () => {
    expect(extractChatgptAccountId(jwt(valid))).toBe('acct-123_x.y');
  });

  it('rejects every malformed shape with the fixed error (nothing echoed)', () => {
    const bad = [
      'not-a-jwt',
      'one.two', // 2 parts
      'a.b.c.d', // 4 parts
      `${b64({})}.!!!.sig`, // non-base64url payload charset
      jwt('a string payload'),
      jwt({}), // claim object absent
      jwt({ chatgpt_account_id: 'acct-1' }), // wrong nesting (top-level)
      jwt({ 'https://api.openai.com/auth': {} }), // id absent
      jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: '' } }),
      jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'has space' } }),
      jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'evil\r\nheader: x' } }),
      jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'a'.repeat(129) } }), // over-long
      jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 42 } }),
    ];
    for (const token of bad) {
      try {
        extractChatgptAccountId(token);
        throw new Error(`expected AccountClaimError`);
      } catch (err) {
        expect(err).toBeInstanceOf(AccountClaimError);
        expect((err as Error).message).toBe('sign-in response did not carry a usable account id');
      }
    }
  });
});
