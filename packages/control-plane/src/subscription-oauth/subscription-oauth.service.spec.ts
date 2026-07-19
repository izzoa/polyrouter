// add-subscription-oauth — resolveCredential state machine: cheap path, coalesced
// single-flight refresh, rotation persistence, invalid_grant → durable local-fail,
// transient → backoff + margin grace, mutation-race adoption, coherence checks.
import {
  PERSISTENCE_FACILITIES,
  PERSISTENCE_PORT,
  REDIS_CLIENT,
  encryptSecret,
  parseCredentialEnvelope,
  decryptSecret,
  serializeOauthCredential,
  serializePlainCredential,
  type PersistencePort,
  type Principal,
  type ProviderRow,
  userPrincipal,
} from '@polyrouter/shared/server';
import { ProviderError } from '@polyrouter/data-plane';
import { Test } from '@nestjs/testing';
import {
  OAUTH_PRESET_LOOKUP,
  OAUTH_TOKEN_FETCH,
  REFRESH_MARGIN_MS,
  SUBSCRIPTION_OAUTH_RUNTIME,
  SubscriptionOauthService,
} from './subscription-oauth.service';
import { TokenEndpointError, type TokenSet } from './oauth-client';
import type { OauthPreset } from './presets';

const KEY = 'b'.repeat(64);
const principal: Principal = userPrincipal('u1');

const PRESET: OauthPreset = {
  id: 'claude',
  displayName: 'Claude',
  baseUrl: 'https://api.anthropic.com',
  protocol: 'anthropic_compatible',
  authorizeUrl: 'https://idp.example/authorize',
  tokenEndpoint: 'https://idp.example/token',
  clientId: 'client-1',
  scopes: 's',
  redirectUri: 'https://idp.example/callback',
  tokenRequestEncoding: 'json',
  includeStateInExchange: true,
  oauthBeta: 'oauth-2025-04-20',
  modelsSource: 'endpoint',
  enabled: true,
};

// A Responses-protocol preset (add-chatgpt-responses): account-id capture, form
// encoding, bundled probe. Enabled here so the unit flow can exercise connect.
const RESPONSES_PRESET: OauthPreset = {
  id: 'chatgpt',
  displayName: 'ChatGPT',
  baseUrl: 'https://chatgpt.example/',
  protocol: 'openai_responses',
  authorizeUrl: 'https://idp.example/authorize',
  tokenEndpoint: 'https://idp.example/token',
  clientId: 'client-2',
  scopes: 'openid profile',
  redirectUri: 'http://localhost:1455/auth/callback',
  tokenRequestEncoding: 'form',
  includeStateInExchange: false,
  modelsSource: 'bundled',
  bundledModels: ['gpt-5', 'gpt-5-codex'],
  probeModel: 'gpt-5',
  enabled: true,
};

const b64 = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url');
const idTokenWith = (accountId: string): string =>
  `${b64({ alg: 'RS256' })}.${b64({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })}.sig`;

function providerRow(over: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: 'prov-1',
    ownerUserId: 'u1',
    orgId: null,
    name: 'claude sub',
    kind: 'subscription',
    protocol: 'anthropic_compatible',
    baseUrl: 'https://api.anthropic.com',
    encryptedCredentials: null,
    status: 'ok',
    oauthPreset: 'claude',
    credentialExpiresAt: null,
    credentialError: null,
    createdAt: new Date(),
    ...over,
  } as ProviderRow;
}

function oauthEnvelope(expiresAt: number, access = 'at-1', refresh = 'rt-1'): string {
  return encryptSecret(
    serializeOauthCredential({ preset: 'claude', accessToken: access, refreshToken: refresh, expiresAt }),
    KEY,
  );
}

function responsesEnvelope(expiresAt: number, accountId?: string): string {
  return encryptSecret(
    serializeOauthCredential({
      preset: 'chatgpt',
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt,
      ...(accountId !== undefined ? { accountId } : {}),
    }),
    KEY,
  );
}

function responsesRow(over: Partial<ProviderRow> = {}): ProviderRow {
  return providerRow({
    id: 'prov-r1',
    protocol: 'openai_responses',
    baseUrl: 'https://chatgpt.example/',
    oauthPreset: 'chatgpt',
    ...over,
  });
}

interface RecordedFetchInput {
  readonly body: Record<string, string>;
  readonly encoding?: 'json' | 'form';
  readonly grant?: 'exchange' | 'refresh';
}

interface Harness {
  svc: SubscriptionOauthService;
  rows: Map<string, ProviderRow>;
  fetches: Array<Record<string, string>>;
  fetchInputs: RecordedFetchInput[];
  redisStore: Map<string, string>;
  setNextToken: (fn: () => Promise<TokenSet>) => void;
}

async function harness(): Promise<Harness> {
  const rows = new Map<string, ProviderRow>();
  const fetches: Array<Record<string, string>> = [];
  const fetchInputs: RecordedFetchInput[] = [];
  const redisStore = new Map<string, string>();
  let nextToken: () => Promise<TokenSet> = () =>
    Promise.resolve({ accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: Date.now() + 3_600_000 });

  const port = {
    providers: {
      findById: (_p: Principal, id: string) => Promise.resolve(rows.get(id) ?? null),
      update: (_p: Principal, id: string, patch: Partial<ProviderRow>) => {
        const cur = rows.get(id);
        if (!cur) return Promise.resolve(null);
        const next = { ...cur, ...patch } as ProviderRow;
        rows.set(id, next);
        return Promise.resolve(next);
      },
      insert: (_p: Principal, values: Record<string, unknown>) => {
        const row = providerRow(values as Partial<ProviderRow>);
        rows.set(row.id, row);
        return Promise.resolve(row);
      },
    },
  } as unknown as PersistencePort;

  const facilities = {
    withAdvisoryLock: (_k: number, fn: (tx: PersistencePort) => Promise<unknown>) => fn(port),
  };

  const redis = {
    get: (k: string) => Promise.resolve(redisStore.get(k) ?? null),
    set: (k: string, v: string) => {
      redisStore.set(k, v);
      return Promise.resolve('OK');
    },
    getdel: (k: string) => {
      const v = redisStore.get(k) ?? null;
      redisStore.delete(k);
      return Promise.resolve(v);
    },
    lpush: () => Promise.resolve(1),
    expire: () => Promise.resolve(1),
    lrange: () => Promise.resolve([]),
    ltrim: () => Promise.resolve('OK'),
    del: () => Promise.resolve(1),
    eval: () => Promise.resolve(1),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      SubscriptionOauthService,
      { provide: PERSISTENCE_PORT, useValue: port },
      { provide: PERSISTENCE_FACILITIES, useValue: facilities },
      { provide: REDIS_CLIENT, useValue: redis },
      { provide: SUBSCRIPTION_OAUTH_RUNTIME, useValue: { key: KEY, mode: 'selfhosted' } },
      {
        provide: OAUTH_TOKEN_FETCH,
        useValue: (input: RecordedFetchInput) => {
          fetches.push(input.body);
          fetchInputs.push(input);
          return nextToken();
        },
      },
      {
        provide: OAUTH_PRESET_LOOKUP,
        useValue: {
          find: (id: string) =>
            id === 'claude' ? PRESET : id === 'chatgpt' ? RESPONSES_PRESET : undefined,
          list: () => [PRESET, RESPONSES_PRESET],
        },
      },
    ],
  }).compile();

  return {
    svc: moduleRef.get(SubscriptionOauthService),
    rows,
    fetches,
    fetchInputs,
    redisStore,
    setNextToken: (fn) => {
      nextToken = fn;
    },
  };
}

describe('SubscriptionOauthService.resolveCredential', () => {
  it('fresh token: cheap path — no IdP call, oauth_bearer + beta', async () => {
    const h = await harness();
    const row = providerRow({ encryptedCredentials: oauthEnvelope(Date.now() + 3_600_000) });
    h.rows.set(row.id, row);
    const r = await h.svc.resolveCredential(principal, row);
    expect(r).toEqual({ credential: 'at-1', authScheme: 'oauth_bearer', oauthBeta: 'oauth-2025-04-20' });
    expect(h.fetches).toHaveLength(0);
  });

  it('plain envelope resolves as api_key (unwrapped)', async () => {
    const h = await harness();
    const row = providerRow({
      oauthPreset: null,
      encryptedCredentials: encryptSecret(serializePlainCredential('sk-paste'), KEY),
    });
    h.rows.set(row.id, row);
    expect(await h.svc.resolveCredential(principal, row)).toEqual({
      credential: 'sk-paste',
      authScheme: 'api_key',
    });
  });

  it('near-expiry: refreshes once, persists rotated tokens + expiry, clears error', async () => {
    const h = await harness();
    const row = providerRow({ encryptedCredentials: oauthEnvelope(Date.now() + 60_000) });
    h.rows.set(row.id, row);
    const r = await h.svc.resolveCredential(principal, row);
    expect(r.credential).toBe('at-2');
    expect(h.fetches).toHaveLength(1);
    expect(h.fetches[0]).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt-1' });
    const stored = h.rows.get(row.id)!;
    const parsed = parseCredentialEnvelope(decryptSecret(stored.encryptedCredentials!, KEY));
    expect(parsed.kind === 'oauth' && parsed.cred.refreshToken).toBe('rt-2'); // rotation persisted
    expect(stored.credentialExpiresAt).not.toBeNull();
  });

  it('coalesces concurrent resolutions into ONE refresh', async () => {
    const h = await harness();
    const row = providerRow({ encryptedCredentials: oauthEnvelope(Date.now() + 60_000) });
    h.rows.set(row.id, row);
    h.setNextToken(
      () =>
        new Promise((r) =>
          setTimeout(
            () => r({ accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: Date.now() + 3_600_000 }),
            20,
          ),
        ),
    );
    const [a, b, c] = await Promise.all([
      h.svc.resolveCredential(principal, row),
      h.svc.resolveCredential(principal, row),
      h.svc.resolveCredential(principal, row),
    ]);
    expect(h.fetches).toHaveLength(1); // single flight
    expect(a.credential).toBe('at-2');
    expect(b.credential).toBe('at-2');
    expect(c.credential).toBe('at-2');
  });

  it('invalid_grant: durable reauthorize_required, then LOCAL fail with no IdP call', async () => {
    const h = await harness();
    const row = providerRow({ encryptedCredentials: oauthEnvelope(Date.now() + 60_000) });
    h.rows.set(row.id, row);
    h.setNextToken(() => Promise.reject(new TokenEndpointError('invalid_grant')));
    await expect(h.svc.resolveCredential(principal, row)).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'credential',
    });
    const stored = h.rows.get(row.id)!;
    expect(stored.credentialError).toBe('reauthorize_required');
    // Subsequent resolution fails locally — no further IdP calls.
    await expect(h.svc.resolveCredential(principal, stored)).rejects.toMatchObject({
      kind: 'credential',
    });
    expect(h.fetches).toHaveLength(1);
  });

  it('transient failure: keeps tokens, sets backoff, serves the still-valid token (grace)', async () => {
    const h = await harness();
    const expiresAt = Date.now() + 60_000; // inside margin but not expired
    const row = providerRow({ encryptedCredentials: oauthEnvelope(expiresAt) });
    h.rows.set(row.id, row);
    h.setNextToken(() => Promise.reject(new TokenEndpointError('transient')));
    const r = await h.svc.resolveCredential(principal, row);
    expect(r.credential).toBe('at-1'); // margin grace
    const stored = h.rows.get(row.id)!;
    expect(stored.credentialError).toBeNull(); // NOT reauthorize_required
    expect(parseCredentialEnvelope(decryptSecret(stored.encryptedCredentials!, KEY)).kind).toBe('oauth');
    expect([...h.redisStore.keys()].some((k) => k.startsWith('oauth:backoff:'))).toBe(true);
    // Backoff active: the next resolution serves the token WITHOUT dialing the IdP.
    await h.svc.resolveCredential(principal, stored);
    expect(h.fetches).toHaveLength(1);
  });

  it('a mutation between read and locked re-read is adopted (no clobber)', async () => {
    const h = await harness();
    const row = providerRow({ encryptedCredentials: oauthEnvelope(Date.now() + 60_000) });
    h.rows.set(row.id, row);
    // Simulate a concurrent PATCH landing before the lock: the stored row becomes a
    // plain pasted credential (the metadata cleared as the Update rule requires).
    h.rows.set(row.id, {
      ...row,
      oauthPreset: null,
      credentialExpiresAt: null,
      encryptedCredentials: encryptSecret(serializePlainCredential('sk-new'), KEY),
    } as ProviderRow);
    const r = await h.svc.resolveCredential(principal, row); // stale row argument
    expect(r).toEqual({ credential: 'sk-new', authScheme: 'api_key' });
    expect(h.fetches).toHaveLength(0); // no refresh, nothing clobbered
  });

  it('coherence: an envelope whose preset disagrees with the row fails typed', async () => {
    const h = await harness();
    const row = providerRow({
      oauthPreset: 'other-preset',
      encryptedCredentials: oauthEnvelope(Date.now() + 3_600_000),
    });
    h.rows.set(row.id, row);
    await expect(h.svc.resolveCredential(principal, row)).rejects.toBeInstanceOf(ProviderError);
    expect(h.fetches).toHaveLength(0);
  });

  it('an undecryptable envelope on an OAuth row becomes durable reauthorize_required (codex r3)', async () => {
    const h = await harness();
    // Encrypted under a DIFFERENT key → decrypt fails (wrong-key/tampered class).
    const wrongKey = 'c'.repeat(64);
    const row = providerRow({
      encryptedCredentials: encryptSecret(
        serializeOauthCredential({ preset: 'claude', accessToken: 'a', refreshToken: 'r', expiresAt: 1 }),
        wrongKey,
      ),
    });
    h.rows.set(row.id, row);
    await expect(h.svc.resolveCredential(principal, row)).rejects.toMatchObject({
      kind: 'credential',
    });
    expect(h.rows.get(row.id)!.credentialError).toBe('reauthorize_required'); // durable
    // Next resolution fails LOCALLY — no decrypt loop, no IdP call.
    await expect(h.svc.resolveCredential(principal, h.rows.get(row.id)!)).rejects.toMatchObject({
      kind: 'credential',
    });
    expect(h.fetches).toHaveLength(0);
  });

  it('a queued waiter re-checks backoff UNDER the lock before dialing the IdP (codex r3)', async () => {
    const h = await harness();
    const row = providerRow({ encryptedCredentials: oauthEnvelope(Date.now() + 60_000) });
    h.rows.set(row.id, row);
    // Another instance already hit a transient failure: the backoff key exists.
    h.redisStore.set(`oauth:backoff:${row.id}`, '1');
    const r = await h.svc.resolveCredential(principal, row);
    expect(r.credential).toBe('at-1'); // margin grace off the still-valid token
    expect(h.fetches).toHaveLength(0); // the lock path did NOT dial the IdP
  });

  it('exposes the margin constant used by the cheap path', () => {
    expect(REFRESH_MARGIN_MS).toBe(5 * 60 * 1000);
  });
});

describe('Responses-protocol credentials (add-chatgpt-responses)', () => {
  async function startAndPaste(h: Harness): Promise<{ sessionId: string; pasted: string }> {
    const started = await h.svc.start(principal, 'auth-sess-1', { preset: 'chatgpt' });
    const state = new URL(started.authorizeUrl).searchParams.get('state')!;
    return {
      sessionId: started.sessionId,
      pasted: `http://localhost:1455/auth/callback?code=c-1&state=${state}`,
    };
  }

  it('connect completion captures the account id into the envelope (form + exchange wire)', async () => {
    const h = await harness();
    h.setNextToken(() =>
      Promise.resolve({
        accessToken: 'at-x',
        refreshToken: 'rt-x',
        expiresAt: Date.now() + 3_600_000,
        idToken: idTokenWith('acct-1'),
      }),
    );
    const { sessionId, pasted } = await startAndPaste(h);
    const row = await h.svc.complete(principal, 'auth-sess-1', { sessionId, pasted });
    expect(row.protocol).toBe('openai_responses');
    expect(row.baseUrl).toBe('https://chatgpt.example/');
    expect(row.oauthPreset).toBe('chatgpt');
    // The account id lives ONLY in the envelope — asserted via in-test decrypt.
    const parsed = parseCredentialEnvelope(decryptSecret(row.encryptedCredentials!, KEY));
    expect(parsed.kind === 'oauth' && parsed.cred.accountId).toBe('acct-1');
    // The wire contract the preset declares: form encoding, exchange grant, and NO
    // `state` in the body (auth.openai.com rejects the unknown parameter — live).
    expect(h.fetchInputs[0]).toMatchObject({ encoding: 'form', grant: 'exchange' });
    expect('state' in h.fetches[0]!).toBe(false);
  });

  it('a missing or invalid id_token claim fails typed with NOTHING written', async () => {
    const h = await harness();
    // Missing id_token entirely.
    h.setNextToken(() =>
      Promise.resolve({ accessToken: 'at-x', refreshToken: 'rt-x', expiresAt: Date.now() + 3_600_000 }),
    );
    const first = await startAndPaste(h);
    await expect(h.svc.complete(principal, 'auth-sess-1', first)).rejects.toMatchObject({
      status: 422,
    });
    expect(h.rows.size).toBe(0);
    // Present but wrongly nested claim.
    h.setNextToken(() =>
      Promise.resolve({
        accessToken: 'at-x',
        refreshToken: 'rt-x',
        expiresAt: Date.now() + 3_600_000,
        idToken: `${b64({ alg: 'RS256' })}.${b64({ chatgpt_account_id: 'acct-1' })}.sig`,
      }),
    );
    const second = await startAndPaste(h);
    await expect(h.svc.complete(principal, 'auth-sess-1', second)).rejects.toMatchObject({
      status: 422,
    });
    expect(h.rows.size).toBe(0);
  });

  it('cheap path threads oauthAccountId + probeModel (trusted envelope/registry data)', async () => {
    const h = await harness();
    const row = responsesRow({
      encryptedCredentials: responsesEnvelope(Date.now() + 3_600_000, 'acct-9'),
    });
    h.rows.set(row.id, row);
    expect(await h.svc.resolveCredential(principal, row)).toEqual({
      credential: 'at-1',
      authScheme: 'oauth_bearer',
      oauthAccountId: 'acct-9',
      probeModel: 'gpt-5',
    });
    expect(h.fetches).toHaveLength(0);
  });

  it('a Responses envelope MISSING its account id is durably tampered', async () => {
    const h = await harness();
    const row = responsesRow({ encryptedCredentials: responsesEnvelope(Date.now() + 3_600_000) });
    h.rows.set(row.id, row);
    await expect(h.svc.resolveCredential(principal, row)).rejects.toMatchObject({
      kind: 'credential',
    });
    const stored = h.rows.get(row.id)!;
    expect(stored.credentialError).toBe('reauthorize_required'); // durable
    // Next resolution fails locally — no IdP call ever.
    await expect(h.svc.resolveCredential(principal, stored)).rejects.toMatchObject({
      kind: 'credential',
    });
    expect(h.fetches).toHaveLength(0);
  });

  it('a plain envelope on a Responses row is durably tampered (never an api_key call)', async () => {
    const h = await harness();
    const row = responsesRow({
      oauthPreset: null, // a PATCH converted it — protocol still cannot run on a paste
      encryptedCredentials: encryptSecret(serializePlainCredential('sk-paste'), KEY),
    });
    h.rows.set(row.id, row);
    await expect(h.svc.resolveCredential(principal, row)).rejects.toMatchObject({
      kind: 'credential',
    });
    expect(h.rows.get(row.id)!.credentialError).toBe('reauthorize_required');
    // And it keeps failing fast locally even without an oauthPreset on the row.
    await expect(h.svc.resolveCredential(principal, h.rows.get(row.id)!)).rejects.toMatchObject({
      kind: 'credential',
    });
    expect(h.fetches).toHaveLength(0);
  });

  it('a transient refresh failure serves the grace token WITH the account id + probe model', async () => {
    const h = await harness();
    const row = responsesRow({
      encryptedCredentials: responsesEnvelope(Date.now() + 60_000, 'acct-9'), // near expiry, still valid
    });
    h.rows.set(row.id, row);
    h.setNextToken(() => Promise.reject(new TokenEndpointError('transient')));
    // Grace must be the FULL resolution — a missing account id would fail the
    // Responses adapter build while the token is still perfectly usable (r3).
    expect(await h.svc.resolveCredential(principal, row)).toEqual({
      credential: 'at-1',
      authScheme: 'oauth_bearer',
      oauthAccountId: 'acct-9',
      probeModel: 'gpt-5',
    });
  });

  it('refresh RETAINS the account id and tolerates an omitted refresh_token', async () => {
    const h = await harness();
    const row = responsesRow({
      encryptedCredentials: responsesEnvelope(Date.now() + 60_000, 'acct-9'),
    });
    h.rows.set(row.id, row);
    // Non-rotating endpoint: the refresh response has NO refresh_token.
    h.setNextToken(() =>
      Promise.resolve({ accessToken: 'at-2', expiresAt: Date.now() + 3_600_000 }),
    );
    const r = await h.svc.resolveCredential(principal, row);
    expect(r).toMatchObject({ credential: 'at-2', oauthAccountId: 'acct-9', probeModel: 'gpt-5' });
    expect(h.fetchInputs.at(-1)).toMatchObject({ encoding: 'form', grant: 'refresh' });
    const parsed = parseCredentialEnvelope(
      decryptSecret(h.rows.get(row.id)!.encryptedCredentials!, KEY),
    );
    expect(parsed.kind).toBe('oauth');
    if (parsed.kind === 'oauth') {
      expect(parsed.cred.refreshToken).toBe('rt-1'); // omission retention
      expect(parsed.cred.accountId).toBe('acct-9'); // survives rotation
      expect(parsed.cred.accessToken).toBe('at-2');
    }
  });
});
