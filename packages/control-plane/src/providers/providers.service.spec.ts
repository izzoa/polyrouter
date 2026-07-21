import { UnprocessableEntityException } from '@nestjs/common';
import type {
  ModelInsertInput,
  ModelRow,
  PersistenceFacilities,
  PersistencePort,
  Principal,
  ProviderInsertInput,
  ProviderPatch,
  ProviderRow,
} from '@polyrouter/shared/server';
import { decryptSecret, resolvePlainCredentialValue } from '@polyrouter/shared/server';
import {
  ProviderError,
  type ConnectionResult,
  type ProviderAdapter,
  type ProviderModelInfo,
} from '@polyrouter/data-plane';
import {
  ProvidersService,
  type ProviderAdapterFactory,
  type ProvidersRuntime,
} from './providers.service';

const KEY = 'a'.repeat(64);
const principal = {} as Principal;
const runtime = (mode: 'selfhosted' | 'cloud'): ProvidersRuntime => ({ key: KEY, mode });

/** Positional-construction helper: supplies stub facilities (lock = passthrough) and a
 * stub subscription-oauth seam (plain unwrap only — these unit tests mint no OAuth
 * envelopes) so the specs stay focused on provider CRUD behavior. */
import type { SubscriptionOauthService } from '../subscription-oauth/subscription-oauth.service';
function mkProvidersService(
  port: PersistencePort,
  f: ProviderAdapterFactory,
  rt: ProvidersRuntime,
): ProvidersService {
  const facilities = {
    withAdvisoryLock: (_k: number, fn: (tx: PersistencePort) => Promise<unknown>) => fn(port),
  } as unknown as PersistenceFacilities;
  const oauth = {
    presetFor: () => undefined,
    resolveCredential: (_p: Principal, row: ProviderRow) =>
      Promise.resolve({
        credential: resolvePlainCredentialValue(
          decryptSecret(row.encryptedCredentials as string, rt.key),
        ),
        authScheme: 'api_key' as const,
      }),
  } as unknown as SubscriptionOauthService;
  return new ProvidersService(port, facilities, f, rt, oauth);
}

interface FakePort {
  port: PersistencePort;
  rows: Map<string, ProviderRow>;
  upsert: jest.Mock<Promise<ModelRow | null>, [Principal, string, ModelInsertInput]>;
}

function makePort(): FakePort {
  const rows = new Map<string, ProviderRow>();
  let seq = 0;
  const mk = (values: ProviderInsertInput): ProviderRow => ({
    id: `p${++seq}`,
    ownerUserId: 'u1',
    orgId: null,
    name: values.name,
    kind: values.kind,
    protocol: values.protocol,
    baseUrl: values.baseUrl ?? null,
    encryptedCredentials: values.encryptedCredentials ?? null,
    status: values.status ?? 'unknown',
    maxTokensSpelling: values.maxTokensSpelling ?? 'auto',
    oauthPreset: values.oauthPreset ?? null,
    credentialExpiresAt: values.credentialExpiresAt ?? null,
    credentialError: values.credentialError ?? null,
    firstByteTimeoutMs: values.firstByteTimeoutMs ?? null,
    idleTimeoutMs: values.idleTimeoutMs ?? null,
    createdAt: new Date(),
  });
  const upsert = jest.fn(
    (_p: Principal, providerId: string, values: ModelInsertInput): Promise<ModelRow | null> =>
      Promise.resolve({
        id: `m${++seq}`,
        providerId,
        externalModelId: values.externalModelId,
        displayName: values.displayName ?? null,
        contextWindow: null,
        supportsTools: false,
        supportsVision: false,
        supportsReasoning: false,
        inputPricePer1m: null,
        outputPricePer1m: null,
        isFree: false,
        listedInputPricePer1m: values.listedInputPricePer1m ?? null,
        listedOutputPricePer1m: values.listedOutputPricePer1m ?? null,
        listedIsFree: values.listedIsFree ?? null,
        listedPriceCapturedAt: values.listedPriceCapturedAt ?? null,
        lastSyncedAt: values.lastSyncedAt ?? null,
      }),
  );
  const port = {
    providers: {
      findById: (_p: Principal, id: string) => Promise.resolve(rows.get(id) ?? null),
      list: () => Promise.resolve([...rows.values()]),
      insert: (_p: Principal, values: ProviderInsertInput) => {
        const row = mk(values);
        rows.set(row.id, row);
        return Promise.resolve(row);
      },
      update: (_p: Principal, id: string, patch: ProviderPatch) => {
        const cur = rows.get(id);
        if (!cur) return Promise.resolve(null);
        const next = { ...cur, ...patch } as ProviderRow;
        rows.set(id, next);
        return Promise.resolve(next);
      },
      remove: (_p: Principal, id: string) => Promise.resolve(rows.delete(id)),
    },
    models: { upsertForProvider: upsert, listForPrincipal: () => Promise.resolve([]) },
  } as unknown as PersistencePort;
  return { port, rows, upsert };
}

function factory(overrides: Partial<ProviderAdapter> = {}): ProviderAdapterFactory {
  const adapter: ProviderAdapter = {
    protocol: 'openai_compatible',
    chat: jest.fn(),
    chatStream: jest.fn(),
    listModels: jest.fn(() => Promise.resolve([] as ProviderModelInfo[])),
    testConnection: jest.fn(() => Promise.resolve({ ok: true, models: 0 } as ConnectionResult)),
    ...overrides,
  };
  return (() => adapter) as unknown as ProviderAdapterFactory;
}

const baseCreate = {
  name: 'p',
  protocol: 'openai_compatible' as const,
};

afterEach(() => jest.restoreAllMocks());

describe('ProvidersService — credentials', () => {
  it('encrypts the credential at rest and never returns it', async () => {
    const { port, rows } = makePort();
    const svc = mkProvidersService(port, factory(), runtime('selfhosted'));
    const safe = await svc.create(principal, {
      ...baseCreate,
      kind: 'api_key',
      baseUrl: 'https://1.1.1.1/v1',
      credential: 'sk-secret-1',
    });
    expect(safe.hasCredential).toBe(true);
    expect(JSON.stringify(safe)).not.toContain('sk-secret-1');
    const stored = [...rows.values()][0]!;
    expect(stored.encryptedCredentials).toMatch(/^poly-enc:/);
    expect(stored.encryptedCredentials).not.toContain('sk-secret-1');
  });
});

describe('ProvidersService — base_url gate', () => {
  const svc = () => mkProvidersService(makePort().port, factory(), runtime('selfhosted'));

  it('rejects userinfo and query/fragment', async () => {
    await expect(
      svc().create(principal, { ...baseCreate, kind: 'custom', baseUrl: 'https://u:p@1.1.1.1/v1' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(
      svc().create(principal, { ...baseCreate, kind: 'custom', baseUrl: 'https://1.1.1.1/v1?x=1' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('rejects a private/metadata address', async () => {
    await expect(
      svc().create(principal, {
        ...baseCreate,
        kind: 'custom',
        baseUrl: 'http://169.254.169.254/v1',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('accepts an arbitrary public HTTPS endpoint (no allow-list)', async () => {
    const created = await svc().create(principal, {
      ...baseCreate,
      kind: 'custom',
      baseUrl: 'https://1.1.1.1/v1',
    });
    expect(created.kind).toBe('custom');
  });

  it('gates local on self-host mode', async () => {
    const cloud = mkProvidersService(makePort().port, factory(), runtime('cloud'));
    await expect(
      cloud.create(principal, { ...baseCreate, kind: 'local', baseUrl: 'http://127.0.0.1:11434' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    const ok = await svc().create(principal, {
      ...baseCreate,
      kind: 'local',
      baseUrl: 'http://127.0.0.1:11434',
    });
    expect(ok.kind).toBe('local');
  });
});

describe('ProvidersService — actions never leak the credential', () => {
  const CRED = 'sk-reflected-9Z';

  it('sanitizes a reflected message and upstream requestId in both actions', async () => {
    const { port } = makePort();
    const seed = mkProvidersService(port, factory(), runtime('selfhosted'));
    const prov = await seed.create(principal, {
      ...baseCreate,
      kind: 'custom',
      baseUrl: 'https://1.1.1.1/v1',
      credential: CRED,
    });
    const reflecting = factory({
      testConnection: () =>
        Promise.resolve({ ok: false, kind: 'bad_request', message: `upstream: ${CRED}` }),
      listModels: () => {
        throw new ProviderError('bad_request', `echo ${CRED}`, { requestId: CRED });
      },
    });
    const svc = mkProvidersService(port, reflecting, runtime('selfhosted'));
    const logs: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        logs.push(a.map(String).join(' '));
      });
    }

    const tc = await svc.testConnection(principal, prov.id);
    expect(tc.ok).toBe(false);
    expect(tc.message).toBe('invalid request to provider');
    expect(JSON.stringify(tc)).not.toContain(CRED);

    const sync = await svc.syncModels(principal, prov.id);
    expect(sync.ok).toBe(false);
    expect(JSON.stringify(sync)).not.toContain(CRED);
    expect(logs.join('\n')).not.toContain(CRED);
  });

  it('rejects an auth-requiring provider with no credential before any adapter call', async () => {
    const { port } = makePort();
    const built = jest.fn();
    const trackingFactory = ((cfg: unknown) => {
      built(cfg);
      return factory()(cfg as never);
    }) as unknown as ProviderAdapterFactory;
    const svc = mkProvidersService(port, trackingFactory, runtime('selfhosted'));
    const prov = await svc.create(principal, {
      ...baseCreate,
      kind: 'api_key',
      baseUrl: 'https://1.1.1.1/v1',
    });
    await expect(svc.testConnection(principal, prov.id)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(built).not.toHaveBeenCalled();
  });
});

describe('ProvidersService — update merged validation & credential preservation', () => {
  it('validates the merged tuple and preserves/clears the credential', async () => {
    const { port, rows } = makePort();
    const svc = mkProvidersService(port, factory(), runtime('selfhosted'));

    const local = await svc.create(principal, {
      ...baseCreate,
      kind: 'local',
      baseUrl: 'http://127.0.0.1:11434',
    });
    // local→custom without a new base_url validates (custom, loopback) → rejected
    await expect(svc.update(principal, local.id, { kind: 'custom' })).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );

    const cust = await svc.create(principal, {
      ...baseCreate,
      kind: 'custom',
      baseUrl: 'https://1.1.1.1/v1',
      credential: 'orig',
    });
    const before = rows.get(cust.id)!.encryptedCredentials;
    await svc.update(principal, cust.id, { name: 'renamed' }); // omit credential → preserved
    expect(rows.get(cust.id)!.encryptedCredentials).toBe(before);
    await svc.update(principal, cust.id, { credential: '' }); // empty → cleared
    expect(rows.get(cust.id)!.encryptedCredentials).toBeNull();
  });
});

describe('ProvidersService — sync-models', () => {
  it('dedupes ids and upserts with no prices', async () => {
    const { port, upsert } = makePort();
    const seed = mkProvidersService(port, factory(), runtime('selfhosted'));
    const prov = await seed.create(principal, {
      ...baseCreate,
      kind: 'custom',
      baseUrl: 'https://1.1.1.1/v1',
      credential: 'k',
    });
    const listing: ProviderModelInfo[] = [
      { id: 'm1', displayName: 'M1' },
      { id: 'm1' },
      { id: 'm2' },
    ];
    const svc = mkProvidersService(
      port,
      factory({ listModels: () => Promise.resolve(listing) }),
      runtime('selfhosted'),
    );
    const res = await svc.syncModels(principal, prov.id);
    expect(res.ok).toBe(true);
    expect(res.synced).toBe(2);
    expect(upsert).toHaveBeenCalledTimes(2);
    for (const call of upsert.mock.calls) {
      const values = call[2];
      expect(values).not.toHaveProperty('inputPricePer1m');
      expect(values).not.toHaveProperty('isFree');
    }
  });

  it('caps the upsert count at MAX_SYNCED_MODELS — no partial 10k flood (E11.1)', async () => {
    const { port, upsert } = makePort();
    const seed = mkProvidersService(port, factory(), runtime('selfhosted'));
    const prov = await seed.create(principal, {
      ...baseCreate,
      kind: 'custom',
      baseUrl: 'https://1.1.1.1/v1',
      credential: 'k',
    });
    const listing: ProviderModelInfo[] = Array.from({ length: 10_000 }, (_v, i) => ({
      id: `m-${String(i)}`,
    }));
    const svc = mkProvidersService(
      port,
      factory({ listModels: () => Promise.resolve(listing) }),
      runtime('selfhosted'),
    );
    const res = await svc.syncModels(principal, prov.id);
    expect(upsert).toHaveBeenCalledTimes(2_000); // MAX_SYNCED_MODELS
    expect(res.synced).toBe(2_000);
  });

  it('skips an over-long id and truncates an over-long display name before upserting (E11.1)', async () => {
    const { port, upsert } = makePort();
    const seed = mkProvidersService(port, factory(), runtime('selfhosted'));
    const prov = await seed.create(principal, {
      ...baseCreate,
      kind: 'custom',
      baseUrl: 'https://1.1.1.1/v1',
      credential: 'k',
    });
    // Special entries first so they fall within the cap and are actually processed.
    const listing: ProviderModelInfo[] = [
      { id: 'z'.repeat(600) }, // > MAX_MODEL_ID_LEN → skipped (a truncated id is a wrong id)
      { id: 'longname', displayName: 'n'.repeat(600) }, // name truncated to MAX_MODEL_NAME_LEN
      { id: 'ok', displayName: 'fine' },
    ];
    const svc = mkProvidersService(
      port,
      factory({ listModels: () => Promise.resolve(listing) }),
      runtime('selfhosted'),
    );
    const res = await svc.syncModels(principal, prov.id);
    // The 600-char id contributed no upsert; the two valid ids did.
    expect(res.synced).toBe(2);
    const ids = upsert.mock.calls.map((c) => (c[2] as ModelInsertInput).externalModelId);
    expect(ids).toEqual(['longname', 'ok']);
    const longNameCall = upsert.mock.calls.find(
      (c) => (c[2] as ModelInsertInput).externalModelId === 'longname',
    );
    expect((longNameCall?.[2] as ModelInsertInput).displayName?.length).toBe(512);
  });
});

describe('listModels — native-family display batch (add-native-price-fallback)', () => {
  it('one priceAtMany with BOTH keys; native_family effectivePrice; listedPrice alongside', async () => {
    const provider = {
      id: 'p-or',
      ownerUserId: 'u1',
      orgId: null,
      name: 'Openrouter',
      kind: 'api_key',
      protocol: 'openai_compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      encryptedCredentials: null,
      status: 'ok',
      oauthPreset: null,
      credentialExpiresAt: null,
      credentialError: null,
      createdAt: new Date(),
    };
    const model = {
      id: 'm1',
      providerId: 'p-or',
      externalModelId: 'minimax/minimax-m3',
      displayName: null,
      contextWindow: null,
      supportsTools: false,
      supportsVision: false,
      supportsReasoning: false,
      isFree: false,
      inputPricePer1m: null,
      outputPricePer1m: null,
      listedInputPricePer1m: 0.3,
      listedOutputPricePer1m: 1.1,
      listedIsFree: false,
      listedPriceCapturedAt: new Date('2026-07-19T00:00:00Z'),
      lastSyncedAt: null,
    };
    const nativeRow = {
      id: 'v-native',
      modelKey: 'minimax:minimax-m3',
      inputPricePer1m: 0.3,
      outputPricePer1m: 1.2,
      cacheReadPricePer1m: 0.06,
      cacheWritePricePer1m: null,
      contextWindow: null,
      supportsTools: false,
      supportsVision: false,
      supportsReasoning: false,
      isFree: false,
      source: 'refresh',
      validFrom: new Date('2026-07-01T00:00:00Z'),
      createdAt: new Date('2026-07-01T00:00:00Z'),
    };
    const priceAtMany = jest.fn((keys: string[]) =>
      Promise.resolve(keys.includes('minimax:minimax-m3') ? [nativeRow] : []),
    );
    const port = {
      providers: { list: () => Promise.resolve([provider]) },
      models: { listForPrincipal: () => Promise.resolve([model]) },
      pricing: { priceAtMany },
    } as unknown as PersistencePort;
    const svc = mkProvidersService(port, factory(), runtime('selfhosted'));
    const out = await svc.listModels(principal, {});

    // Exactly ONE batch query carrying BOTH the exact and native keys (no N+1).
    expect(priceAtMany).toHaveBeenCalledTimes(1);
    const keys = priceAtMany.mock.calls[0]![0] as string[];
    expect(keys).toEqual(
      expect.arrayContaining(['openrouter:minimax/minimax-m3', 'minimax:minimax-m3']),
    );
    // The effective price is the flagged native-family estimate...
    expect(out[0]!.effectivePrice).toMatchObject({
      source: 'native_family',
      estimated: true,
      inputPricePer1m: 0.3,
      outputPricePer1m: 1.2,
    });
    // ...with the provider-listed channel figure carried ALONGSIDE, not replaced.
    expect(out[0]!.listedPrice).toMatchObject({ inputPricePer1m: 0.3, outputPricePer1m: 1.1 });
  });
});

describe('ProvidersService — max-tokens spelling resolution (add-max-tokens-spelling)', () => {
  function trackingSvc() {
    const { port } = makePort();
    const cfgs: { quirks?: { maxTokensSpelling?: string } }[] = [];
    const trackingFactory = ((cfg: unknown) => {
      cfgs.push(cfg as { quirks?: { maxTokensSpelling?: string } });
      return factory()(cfg as never);
    }) as unknown as ProviderAdapterFactory;
    return { svc: mkProvidersService(port, trackingFactory, runtime('selfhosted')), cfgs };
  }

  it('auto resolves openai_compatible by kind (local→max_tokens, api_key→max_completion_tokens)', async () => {
    const { svc, cfgs } = trackingSvc();
    const local = await svc.create(principal, {
      ...baseCreate,
      kind: 'local',
      baseUrl: 'http://localhost:11434/v1',
    });
    const hosted = await svc.create(principal, {
      ...baseCreate,
      kind: 'api_key',
      baseUrl: 'https://1.1.1.1/v1',
      credential: 'sk-x',
    });
    await svc.testConnection(principal, local.id);
    await svc.testConnection(principal, hosted.id);
    expect(cfgs[0]!.quirks?.maxTokensSpelling).toBe('max_tokens');
    expect(cfgs[1]!.quirks?.maxTokensSpelling).toBe('max_completion_tokens');
  });

  it('an explicit spelling overrides the kind default and round-trips on the safe shape', async () => {
    const { svc, cfgs } = trackingSvc();
    const p = await svc.create(principal, {
      ...baseCreate,
      kind: 'local',
      baseUrl: 'http://localhost:11434/v1',
      maxTokensSpelling: 'max_completion_tokens',
    });
    expect(p.maxTokensSpelling).toBe('max_completion_tokens'); // persisted + returned on the safe shape
    expect((await svc.get(principal, p.id)).maxTokensSpelling).toBe('max_completion_tokens');
    await svc.testConnection(principal, p.id);
    expect(cfgs[0]!.quirks?.maxTokensSpelling).toBe('max_completion_tokens');
  });

  it('defaults the persisted value to auto', async () => {
    const { svc } = trackingSvc();
    const p = await svc.create(principal, {
      ...baseCreate,
      kind: 'api_key',
      baseUrl: 'https://1.1.1.1/v1',
      credential: 'sk-z',
    });
    expect(p.maxTokensSpelling).toBe('auto');
  });

  it('is inert for anthropic_compatible providers (undefined quirks)', async () => {
    const { svc, cfgs } = trackingSvc();
    const p = await svc.create(principal, {
      ...baseCreate,
      protocol: 'anthropic_compatible' as const,
      kind: 'api_key',
      baseUrl: 'https://1.1.1.1',
      credential: 'sk-y',
    });
    await svc.testConnection(principal, p.id);
    expect(cfgs[0]!.quirks).toBeUndefined();
  });
});
