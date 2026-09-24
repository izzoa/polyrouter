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
    serializeOauthCredential({
      preset: 'claude',
      accessToken: access,
      refreshToken: refresh,
      expiresAt,
    }),
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
  redis: {
    set: (...args: never[]) => Promise<unknown>;
    eval: (...args: never[]) => Promise<unknown>;
  };
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
    Promise.resolve({
      accessToken: 'at-2',
      refreshToken: 'rt-2',
      expiresAt: Date.now() + 3_600_000,
    });

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
      // Mirrors of the guarded health writes (real semantics: provider-health-writes.e2e).
      setHealth: (
        _p: Principal,
        id: string,
        patch: { record: string; status?: string; kind: string | null; source?: string },
        guard: { envelope: string | null; baseUrl: string | null; protocol: string },
      ) => {
        const cur = rows.get(id);
        if (
          !cur ||
          cur.encryptedCredentials !== guard.envelope ||
          cur.baseUrl !== guard.baseUrl ||
          cur.protocol !== guard.protocol ||
          patch.record !== 'check'
        ) {
          return Promise.resolve(false);
        }
        rows.set(id, {
          ...cur,
          status: patch.status!,
          lastErrorKind: patch.status === 'error' ? patch.kind : null,
          statusSource: patch.source!,
        } as ProviderRow);
        return Promise.resolve(true);
      },
      updateResettingHealth: (
        _p: Principal,
        id: string,
        patch: Partial<ProviderRow>,
        source: string,
      ) => {
        const cur = rows.get(id);
        if (!cur) return Promise.resolve(null);
        const next = {
          ...cur,
          ...patch,
          status: 'unknown',
          lastErrorKind: null,
          statusSource: source,
          trafficState: null,
        } as ProviderRow;
        rows.set(id, next);
        return Promise.resolve(next);
      },
    },
  } as unknown as PersistencePort;

  const facilities = {
    withAdvisoryLock: (_k: number, fn: (tx: PersistencePort) => Promise<unknown>) => fn(port),
  };

  const redis = {
    get: (k: string) => Promise.resolve(redisStore.get(k) ?? null),
    // Honors NX like Redis (the forced-refresh and test-repair claims rely on it).
    set: (k: string, v: string, ...args: unknown[]) => {
      if (args.includes('NX') && redisStore.has(k)) return Promise.resolve(null);
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
    redis: redis as unknown as Harness['redis'],
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
    expect(r).toEqual({
      credential: 'at-1',
      authScheme: 'oauth_bearer',
      oauthBeta: 'oauth-2025-04-20',
      envelope: row.encryptedCredentials, // the stored envelope it resolved
    });
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
      envelope: row.encryptedCredentials,
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
    // add-provider-health-signals: the resolution reports the NEWLY written envelope.
    expect(r.envelope).toBe(stored.encryptedCredentials);
    expect(r.envelope).not.toBe(row.encryptedCredentials);
    expect(h.redisStore.get('oauth:verified:prov-1')).toBe('1'); // a real exchange verifies
  });

  it('coalesces concurrent resolutions into ONE refresh', async () => {
    const h = await harness();
    const row = providerRow({ encryptedCredentials: oauthEnvelope(Date.now() + 60_000) });
    h.rows.set(row.id, row);
    h.setNextToken(
      () =>
        new Promise((r) =>
          setTimeout(
            () =>
              r({ accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: Date.now() + 3_600_000 }),
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
    expect(stored).toMatchObject({
      credentialError: 'reauthorize_required',
      status: 'error',
      lastErrorKind: 'credential',
      statusSource: 'refresh',
    });
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
    expect(parseCredentialEnvelope(decryptSecret(stored.encryptedCredentials!, KEY)).kind).toBe(
      'oauth',
    );
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
    // The ADOPTED (re-read) envelope is reported — not the stale row's.
    expect(r).toEqual({
      credential: 'sk-new',
      authScheme: 'api_key',
      envelope: h.rows.get(row.id)!.encryptedCredentials,
    });
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
        serializeOauthCredential({
          preset: 'claude',
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: 1,
        }),
        wrongKey,
      ),
    });
    h.rows.set(row.id, row);
    await expect(h.svc.resolveCredential(principal, row)).rejects.toMatchObject({
      kind: 'credential',
    });
    expect(h.rows.get(row.id)!.credentialError).toBe('reauthorize_required'); // durable
    expect(h.rows.get(row.id)).toMatchObject({
      credentialError: 'reauthorize_required',
      status: 'error',
      lastErrorKind: 'credential',
      statusSource: 'refresh',
    });
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
      Promise.resolve({
        accessToken: 'at-x',
        refreshToken: 'rt-x',
        expiresAt: Date.now() + 3_600_000,
      }),
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
      envelope: row.encryptedCredentials,
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
    expect(stored).toMatchObject({
      credentialError: 'reauthorize_required',
      status: 'error',
      lastErrorKind: 'credential',
      statusSource: 'refresh',
    });
    // Next resolution fails locally — no IdP call ever.
    await expect(h.svc.resolveCredential(principal, stored)).rejects.toMatchObject({
      kind: 'credential',
    });
    expect(h.fetches).toHaveLength(0);
  });

  // add-provider-health-signals (task 2.3): the two refresh-under-lock branches a
  // QUEUED waiter reaches — the row it re-reads under the lock is not the one it
  // resolved from — record the same shared check record.
  it('under the lock: a plain envelope found on a Responses row records the shared check', async () => {
    const h = await harness();
    const resolvedFrom = responsesRow({
      encryptedCredentials: responsesEnvelope(Date.now() + 60_000, 'acct-1'),
    });
    h.rows.set(
      resolvedFrom.id,
      responsesRow({ encryptedCredentials: encryptSecret(serializePlainCredential('sk-x'), KEY) }),
    );
    await expect(h.svc.resolveCredential(principal, resolvedFrom)).rejects.toMatchObject({
      kind: 'credential',
    });
    expect(h.rows.get(resolvedFrom.id)).toMatchObject({
      credentialError: 'reauthorize_required',
      status: 'error',
      lastErrorKind: 'credential',
      statusSource: 'refresh',
    });
    expect(h.fetches).toHaveLength(0);
  });

  it('under the lock: an envelope missing its account id records the shared check', async () => {
    const h = await harness();
    const resolvedFrom = responsesRow({
      encryptedCredentials: responsesEnvelope(Date.now() + 60_000, 'acct-1'),
    });
    h.rows.set(
      resolvedFrom.id,
      responsesRow({ encryptedCredentials: responsesEnvelope(Date.now() + 60_000) }),
    );
    await expect(h.svc.resolveCredential(principal, resolvedFrom)).rejects.toMatchObject({
      kind: 'credential',
    });
    expect(h.rows.get(resolvedFrom.id)).toMatchObject({
      credentialError: 'reauthorize_required',
      status: 'error',
      lastErrorKind: 'credential',
      statusSource: 'refresh',
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
    expect(h.rows.get(row.id)).toMatchObject({
      credentialError: 'reauthorize_required',
      status: 'error',
      lastErrorKind: 'credential',
      statusSource: 'refresh',
    });
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
      envelope: row.encryptedCredentials, // grace: the untouched stored envelope
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

// add-provider-health-signals (tasks 3.2–3.4): the forced refresh is REALLY forced,
// keyed on the stored credential the caller used, with explicit outcomes.
describe('forceRefresh / requestForcedRefresh / claimTestRepair (add-provider-health-signals)', () => {
  const HOURS_240 = 240 * 60 * 60 * 1000;

  it('a 240h-expiry credential is refreshed: exactly one exchange, rotated, verified', async () => {
    const h = await harness();
    const row = providerRow({ encryptedCredentials: oauthEnvelope(Date.now() + HOURS_240) });
    h.rows.set(row.id, row);
    await expect(
      h.svc.forceRefresh(principal, row.id, row.encryptedCredentials!, '401'),
    ).resolves.toBe('refreshed');
    expect(h.fetches).toHaveLength(1);
    expect(h.rows.get(row.id)!.encryptedCredentials).not.toBe(row.encryptedCredentials);
    expect(h.redisStore.get('oauth:verified:prov-1')).toBe('1');
  });

  it('keyed on a lazily refreshed envelope, the forced refresh proceeds', async () => {
    const h = await harness();
    const row = providerRow({ encryptedCredentials: oauthEnvelope(Date.now() + 60_000) });
    h.rows.set(row.id, row);
    const lazy = await h.svc.resolveCredential(principal, row); // refreshes inside the "build"
    expect(h.fetches).toHaveLength(1);
    h.setNextToken(() =>
      Promise.resolve({
        accessToken: 'at-3',
        refreshToken: 'rt-3',
        expiresAt: Date.now() + HOURS_240,
      }),
    );
    await expect(h.svc.forceRefresh(principal, row.id, lazy.envelope, '401')).resolves.toBe(
      'refreshed',
    );
    expect(h.fetches).toHaveLength(2);
  });

  it('a credential replaced in between (reauthorize/PATCH) is adopted — no exchange, no write', async () => {
    const h = await harness();
    // The SAME expiry on both versions: an expiry-keyed compare could not tell them
    // apart — only the envelope (fresh IV per write) can.
    const expiresAt = Date.now() + HOURS_240;
    const row = providerRow({ encryptedCredentials: oauthEnvelope(expiresAt) });
    const replaced = { ...row, encryptedCredentials: oauthEnvelope(expiresAt, 'at-9', 'rt-9') };
    h.rows.set(row.id, replaced as ProviderRow);
    await expect(
      h.svc.forceRefresh(principal, row.id, row.encryptedCredentials!, '401'),
    ).resolves.toBe('adopted');
    expect(h.fetches).toHaveLength(0);
    expect(h.rows.get(row.id)!.encryptedCredentials).toBe(replaced.encryptedCredentials);
  });

  it('a cleared credential or a non-OAuth row aborts with nothing written', async () => {
    const h = await harness();
    const cleared = providerRow({ encryptedCredentials: null });
    h.rows.set(cleared.id, cleared);
    await expect(h.svc.forceRefresh(principal, cleared.id, 'whatever', '401')).resolves.toBe(
      'aborted',
    );
    const plain = providerRow({
      id: 'prov-plain',
      oauthPreset: null,
      encryptedCredentials: encryptSecret(serializePlainCredential('sk-x'), KEY),
    });
    h.rows.set(plain.id, plain);
    await expect(
      h.svc.forceRefresh(principal, plain.id, plain.encryptedCredentials!, '401'),
    ).resolves.toBe('aborted');
    expect(h.fetches).toHaveLength(0);
  });

  it('a durable credential error reports reauthorize_required without dialing', async () => {
    const h = await harness();
    const row = providerRow({
      encryptedCredentials: oauthEnvelope(Date.now() + HOURS_240),
      credentialError: 'reauthorize_required',
    });
    h.rows.set(row.id, row);
    await expect(
      h.svc.forceRefresh(principal, row.id, row.encryptedCredentials!, '401'),
    ).resolves.toBe('reauthorize_required');
    expect(h.fetches).toHaveLength(0);
  });

  it('a held backoff reports transient without dialing', async () => {
    const h = await harness();
    const row = providerRow({ encryptedCredentials: oauthEnvelope(Date.now() + HOURS_240) });
    h.rows.set(row.id, row);
    h.redisStore.set('oauth:backoff:prov-1', '1');
    await expect(
      h.svc.forceRefresh(principal, row.id, row.encryptedCredentials!, 'scheduled'),
    ).resolves.toBe('transient');
    expect(h.fetches).toHaveLength(0);
  });

  it('a transient failure with a still-valid token is transient — never refreshed, never verified', async () => {
    const h = await harness();
    const row = providerRow({ encryptedCredentials: oauthEnvelope(Date.now() + HOURS_240) });
    h.rows.set(row.id, row);
    h.setNextToken(() => Promise.reject(new TokenEndpointError('transient')));
    await expect(
      h.svc.forceRefresh(principal, row.id, row.encryptedCredentials!, 'scheduled'),
    ).resolves.toBe('transient');
    expect(h.rows.get(row.id)!.encryptedCredentials).toBe(row.encryptedCredentials); // untouched
    expect(h.redisStore.get('oauth:backoff:prov-1')).toBe('1');
    expect(h.redisStore.has('oauth:verified:prov-1')).toBe(false);
  });

  it('invalid_grant is durable reauthorize_required with the shared check record', async () => {
    const h = await harness();
    const row = providerRow({ encryptedCredentials: oauthEnvelope(Date.now() + HOURS_240) });
    h.rows.set(row.id, row);
    h.setNextToken(() => Promise.reject(new TokenEndpointError('invalid_grant')));
    await expect(
      h.svc.forceRefresh(principal, row.id, row.encryptedCredentials!, '401'),
    ).resolves.toBe('reauthorize_required');
    expect(h.rows.get(row.id)).toMatchObject({
      credentialError: 'reauthorize_required',
      status: 'error',
      lastErrorKind: 'credential',
      statusSource: 'refresh',
    });
  });

  it('a forced refresh never touches the breaker — whatever its outcome (only a reconnect resets it)', async () => {
    const h = await harness();
    // The breaker store's reset is the service's ONLY breaker write, via redis.eval.
    const evalSpy = jest.spyOn(h.redis, 'eval');
    const ok = providerRow({ encryptedCredentials: oauthEnvelope(Date.now() + HOURS_240) });
    h.rows.set(ok.id, ok);
    await expect(
      h.svc.forceRefresh(principal, ok.id, ok.encryptedCredentials!, '401'),
    ).resolves.toBe('refreshed');
    const dead = providerRow({
      id: 'prov-dead',
      encryptedCredentials: oauthEnvelope(Date.now() + HOURS_240),
    });
    h.rows.set(dead.id, dead);
    h.setNextToken(() => Promise.reject(new TokenEndpointError('invalid_grant')));
    await expect(
      h.svc.forceRefresh(principal, dead.id, dead.encryptedCredentials!, '401'),
    ).resolves.toBe('reauthorize_required');
    expect(evalSpy).not.toHaveBeenCalled();
  });

  it('requestForcedRefresh: 50 concurrent calls for one credential → one exchange', async () => {
    const h = await harness();
    const row = providerRow({ encryptedCredentials: oauthEnvelope(Date.now() + HOURS_240) });
    h.rows.set(row.id, row);
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () =>
        h.svc.requestForcedRefresh(principal, row.id, row.encryptedCredentials!),
      ),
    );
    expect(h.fetches).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'refreshed')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'skipped')).toHaveLength(49);
  });

  it("requestForcedRefresh: a late old-credential 401 adopts and does not block the new credential's repair", async () => {
    const h = await harness();
    const old = providerRow({ encryptedCredentials: oauthEnvelope(Date.now() + HOURS_240) });
    const current = {
      ...old,
      encryptedCredentials: oauthEnvelope(Date.now() + HOURS_240, 'at-8', 'rt-8'),
    };
    h.rows.set(old.id, current as ProviderRow);
    await expect(
      h.svc.requestForcedRefresh(principal, old.id, old.encryptedCredentials!),
    ).resolves.toBe('adopted');
    expect(h.fetches).toHaveLength(0);
    await expect(
      h.svc.requestForcedRefresh(principal, old.id, current.encryptedCredentials!),
    ).resolves.toBe('refreshed');
    expect(h.fetches).toHaveLength(1);
  });

  it('requestForcedRefresh fails closed on a Redis error: no exchange, no rejection', async () => {
    const h = await harness();
    const row = providerRow({ encryptedCredentials: oauthEnvelope(Date.now() + HOURS_240) });
    h.rows.set(row.id, row);
    jest.spyOn(h.redis, 'set').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      h.svc.requestForcedRefresh(principal, row.id, row.encryptedCredentials!),
    ).resolves.toBe('skipped');
    expect(h.fetches).toHaveLength(0);
  });

  it('claimTestRepair: one per window; fails closed on a Redis error', async () => {
    const h = await harness();
    await expect(h.svc.claimTestRepair('prov-1')).resolves.toBe(true);
    await expect(h.svc.claimTestRepair('prov-1')).resolves.toBe(false);
    await expect(h.svc.claimTestRepair('prov-2')).resolves.toBe(true);
    jest.spyOn(h.redis, 'set').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(h.svc.claimTestRepair('prov-3')).resolves.toBe(false);
  });
});
