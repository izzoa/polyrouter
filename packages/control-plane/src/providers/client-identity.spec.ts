// allow-preset-client-identity — the declaration type's validation (design D2).
import {
  clientIdentityFor,
  identityHeaders,
  MAX_IDENTITY_VALUE_LENGTH,
  RESERVED_IDENTITY_HEADER_NAMES,
  isValidClientIdentity,
  validateClientIdentity,
  type IdentityBinding,
  type IdentityRow,
  type PresetClientIdentity,
} from './client-identity';

const VALID: PresetClientIdentity = {
  label: 'Example CLI',
  apiHeaders: { 'User-Agent': 'fixture-client/1.0', 'X-Fixture-Client': 'polyrouter-test' },
  tokenHeaders: { 'User-Agent': 'fixture-auth/1.0' },
};

const mixedCase = (name: string): string =>
  [...name].map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase())).join('');

describe('validateClientIdentity', () => {
  it('accepts a valid fixture, and the same name in apiHeaders and tokenHeaders', () => {
    expect(validateClientIdentity(VALID)).toEqual([]);
    expect(isValidClientIdentity(VALID)).toBe(true);
    // 'User-Agent' is in both maps of VALID — separate maps are allowed.
    expect(Object.keys(VALID.apiHeaders)).toContain('User-Agent');
    expect(Object.keys(VALID.tokenHeaders ?? {})).toContain('User-Agent');
  });

  it('accepts an identity with no tokenHeaders', () => {
    expect(isValidClientIdentity({ label: 'X', apiHeaders: { 'User-Agent': 'x/1' } })).toBe(true);
  });

  it('rejects an empty, blank or over-long label', () => {
    expect(isValidClientIdentity({ ...VALID, label: '' })).toBe(false);
    expect(isValidClientIdentity({ ...VALID, label: '   ' })).toBe(false);
    expect(isValidClientIdentity({ ...VALID, label: 'x'.repeat(65) })).toBe(false);
    expect(isValidClientIdentity({ ...VALID, label: 'x'.repeat(64) })).toBe(true);
  });

  it('rejects an empty header map, in apiHeaders and in tokenHeaders', () => {
    expect(isValidClientIdentity({ ...VALID, apiHeaders: {} })).toBe(false);
    expect(isValidClientIdentity({ ...VALID, tokenHeaders: {} })).toBe(false);
  });

  it.each(['', 'bad name', 'bad:name', 'bad\nname', 'naïve', '(x)', 'a/b'])(
    'rejects the non-token header name %j',
    (name) => {
      expect(isValidClientIdentity({ ...VALID, apiHeaders: { [name]: 'v' } })).toBe(false);
      expect(isValidClientIdentity({ ...VALID, tokenHeaders: { [name]: 'v' } })).toBe(false);
    },
  );

  it('rejects two names in one map that differ only in letter case', () => {
    const dup = { 'User-Agent': 'a', 'user-agent': 'b' };
    expect(isValidClientIdentity({ ...VALID, apiHeaders: dup })).toBe(false);
    expect(isValidClientIdentity({ ...VALID, tokenHeaders: dup })).toBe(false);
    expect(validateClientIdentity({ ...VALID, apiHeaders: dup }).join()).toContain('apiHeaders');
    expect(validateClientIdentity({ ...VALID, tokenHeaders: dup }).join()).toContain(
      'tokenHeaders',
    );
  });

  it.each(['a\rb', 'a\nb', 'a\0b', 'a\tb', 'a\u007fb'])(
    'rejects a value with a control character %j',
    (value) => {
      expect(isValidClientIdentity({ ...VALID, apiHeaders: { 'X-A': value } })).toBe(false);
      expect(isValidClientIdentity({ ...VALID, tokenHeaders: { 'X-A': value } })).toBe(false);
    },
  );

  it('rejects an empty value and a value over 256 characters', () => {
    expect(isValidClientIdentity({ ...VALID, apiHeaders: { 'X-A': '' } })).toBe(false);
    const limit = 'x'.repeat(MAX_IDENTITY_VALUE_LENGTH);
    expect(isValidClientIdentity({ ...VALID, apiHeaders: { 'X-A': limit } })).toBe(true);
    expect(isValidClientIdentity({ ...VALID, apiHeaders: { 'X-A': limit + 'x' } })).toBe(false);
    expect(isValidClientIdentity({ ...VALID, tokenHeaders: { 'X-A': limit + 'x' } })).toBe(false);
  });

  it('never echoes a header value in a problem message', () => {
    const secretish = 'sk-live-should-not-leak\n';
    const msgs = validateClientIdentity({ ...VALID, apiHeaders: { 'X-A': secretish } });
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.join(' ')).not.toContain('sk-live');
  });

  describe('reserved names (design D2 set)', () => {
    it('is exactly the documented set', () => {
      expect([...RESERVED_IDENTITY_HEADER_NAMES].sort()).toEqual(
        [
          'authorization',
          'proxy-authorization',
          'x-api-key',
          'anthropic-version',
          'anthropic-beta',
          'chatgpt-account-id',
          'openai-beta',
          'content-type',
          'content-length',
          'content-encoding',
          'accept',
          'accept-encoding',
          'transfer-encoding',
          'connection',
          'keep-alive',
          'te',
          'upgrade',
          'host',
          'cookie',
          'http-referer',
          'x-openrouter-title',
        ].sort(),
      );
    });

    for (const name of RESERVED_IDENTITY_HEADER_NAMES) {
      it.each([
        ['lower', name.toLowerCase()],
        ['upper', name.toUpperCase()],
        ['mixed', mixedCase(name)],
      ])(`rejects ${name} in %s case, in apiHeaders and tokenHeaders`, (_label, spelled) => {
        expect(isValidClientIdentity({ ...VALID, apiHeaders: { [spelled]: 'v' } })).toBe(false);
        expect(isValidClientIdentity({ ...VALID, tokenHeaders: { [spelled]: 'v' } })).toBe(false);
      });
    }
  });
});

describe('clientIdentityFor (the availability rule)', () => {
  const PIN: IdentityBinding['pin'] = {
    baseUrl: 'https://identity.example.test/',
    protocol: 'openai_compatible',
  };
  const BINDING: IdentityBinding = { identity: VALID, pin: PIN };
  const ROW: IdentityRow = {
    kind: 'subscription',
    baseUrl: PIN.baseUrl,
    protocol: PIN.protocol,
  };

  it('returns the declaration when every condition holds', () => {
    expect(clientIdentityFor(ROW, BINDING)).toBe(VALID);
  });

  it.each([
    ['kind is not subscription', { ...ROW, kind: 'api_key' } as IdentityRow, BINDING],
    ['there is no binding', ROW, undefined],
    ['the binding declares no identity', ROW, { identity: undefined, pin: PIN }],
    [
      'the base_url differs from the pin',
      { ...ROW, baseUrl: 'https://elsewhere.example.test/' },
      BINDING,
    ],
    ['the protocol differs from the pin', { ...ROW, protocol: 'anthropic_compatible' }, BINDING],
  ] as Array<[string, IdentityRow, IdentityBinding | undefined]>)(
    'returns null when %s (alone)',
    (_name, row, binding) => {
      expect(clientIdentityFor(row, binding)).toBeNull();
    },
  );

  it('returns null for a declaration that fails validation, every other condition met', () => {
    const reserved: PresetClientIdentity = { label: 'Bad', apiHeaders: { 'x-api-key': 'k' } };
    const dup: PresetClientIdentity = {
      label: 'Dup',
      apiHeaders: { 'User-Agent': 'a', 'user-agent': 'b' },
    };
    expect(clientIdentityFor(ROW, { identity: reserved, pin: PIN })).toBeNull();
    expect(clientIdentityFor(ROW, { identity: dup, pin: PIN })).toBeNull();
    // Memoized: a second ask answers the same.
    expect(clientIdentityFor(ROW, { identity: reserved, pin: PIN })).toBeNull();
    expect(clientIdentityFor(ROW, BINDING)).toBe(VALID);
  });

  it('serves a row on either pin of one declaration (the multi-region shape)', () => {
    const pinA = { baseUrl: 'https://a.example.test/', protocol: 'openai_compatible' } as const;
    const pinB = { baseUrl: 'https://b.example.test/', protocol: 'anthropic_compatible' } as const;
    const rowA: IdentityRow = { kind: 'subscription', ...pinA };
    const rowB: IdentityRow = { kind: 'subscription', ...pinB };
    expect(clientIdentityFor(rowA, { identity: VALID, pin: pinA })).toBe(VALID);
    expect(clientIdentityFor(rowB, { identity: VALID, pin: pinB })).toBe(VALID);
    // A row matching the OTHER binding's pin is not available under this one.
    expect(clientIdentityFor(rowA, { identity: VALID, pin: pinB })).toBeNull();
  });
});

describe('identityHeaders (the switch)', () => {
  it('returns apiHeaders or tokenHeaders only while the row switch is on', () => {
    expect(identityHeaders({ imitateClientIdentity: true }, VALID, 'api')).toBe(VALID.apiHeaders);
    expect(identityHeaders({ imitateClientIdentity: true }, VALID, 'token')).toBe(
      VALID.tokenHeaders,
    );
    expect(identityHeaders({ imitateClientIdentity: false }, VALID, 'api')).toBeUndefined();
    expect(identityHeaders({ imitateClientIdentity: false }, VALID, 'token')).toBeUndefined();
  });

  it('returns nothing when no identity is available', () => {
    expect(identityHeaders({ imitateClientIdentity: true }, null, 'api')).toBeUndefined();
    expect(identityHeaders({ imitateClientIdentity: true }, null, 'token')).toBeUndefined();
  });

  it('returns nothing on the token surface when the preset declares no tokenHeaders', () => {
    const apiOnly: PresetClientIdentity = { label: 'X', apiHeaders: { 'User-Agent': 'x/1' } };
    expect(identityHeaders({ imitateClientIdentity: true }, apiOnly, 'token')).toBeUndefined();
    expect(identityHeaders({ imitateClientIdentity: true }, apiOnly, 'api')).toBe(
      apiOnly.apiHeaders,
    );
  });
});
