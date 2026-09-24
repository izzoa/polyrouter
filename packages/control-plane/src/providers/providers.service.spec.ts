import { resolveModelPrice } from '@polyrouter/shared/server';
import { batchFactoryFor } from '@polyrouter/data-plane';
import { UnprocessableEntityException } from '@nestjs/common';
import type {
  ModelInsertInput,
  ModelPriceRow,
  ModelRow,
  PersistenceFacilities,
  PersistencePort,
  Principal,
  ProviderInsertInput,
  ProviderPatch,
  ProviderRow,
  ProviderHealthPatch,
  ProviderIncarnation,
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
    lastErrorKind: values.lastErrorKind ?? null,
    statusSource: values.statusSource ?? null,
    statusChangedAt: values.statusChangedAt ?? null,
    statusRev: values.statusRev ?? null,
    trafficState: values.trafficState ?? null,
    trafficErrorKind: values.trafficErrorKind ?? null,
    trafficAt: values.trafficAt ?? null,
    trafficSeq: values.trafficSeq ?? null,
    trafficRev: values.trafficRev ?? null,
    healthRev: values.healthRev ?? 0,
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
        variant: values.variant ?? null,
        // capability columns dropped from the model row (honest-model-capabilities)
        inputPricePer1m: null,
        outputPricePer1m: null,
        isFree: false,
        listedInputPricePer1m: values.listedInputPricePer1m ?? null,
        listedOutputPricePer1m: values.listedOutputPricePer1m ?? null,
        listedIsFree: values.listedIsFree ?? null,
        listedPriceCapturedAt: values.listedPriceCapturedAt ?? null,
        listedSupportsTools: null,
        listedSupportsVision: null,
        listedSupportsReasoning: null,
        listedContextWindow: null,
        listedCapabilitiesCapturedAt: null,
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
      // In-memory mirror of the guarded, revisioned health write (the real
      // semantics are proven against Postgres in provider-health-writes.e2e).
      setHealth: (
        _p: Principal,
        id: string,
        patch: ProviderHealthPatch,
        guard: ProviderIncarnation,
      ) => {
        const cur = rows.get(id);
        if (
          !cur ||
          cur.encryptedCredentials !== guard.envelope ||
          cur.baseUrl !== guard.baseUrl ||
          cur.protocol !== guard.protocol
        ) {
          return Promise.resolve(false);
        }
        const rev = cur.healthRev + 1;
        if (patch.record === 'check') {
          rows.set(id, {
            ...cur,
            status: patch.status,
            lastErrorKind: patch.status === 'error' ? patch.kind : null,
            statusSource: patch.source,
            statusChangedAt: new Date(),
            statusRev: rev,
            healthRev: rev,
          });
          return Promise.resolve(true);
        }
        if (cur.trafficSeq !== null && cur.trafficSeq >= patch.seq) return Promise.resolve(false);
        rows.set(id, {
          ...cur,
          trafficState: patch.state,
          trafficErrorKind: patch.state === 'failing' ? patch.kind : null,
          trafficAt: new Date(),
          trafficSeq: patch.seq,
          trafficRev: rev,
          healthRev: rev,
        });
        return Promise.resolve(true);
      },
      updateResettingHealth: (
        _p: Principal,
        id: string,
        patch: ProviderPatch,
        source: 'edit' | 'reconnect',
      ) => {
        const cur = rows.get(id);
        if (!cur) return Promise.resolve(null);
        const rev = cur.healthRev + 1;
        const next = {
          ...cur,
          ...patch,
          status: 'unknown',
          lastErrorKind: null,
          statusSource: source,
          statusChangedAt: new Date(),
          statusRev: rev,
          trafficState: null,
          trafficErrorKind: null,
          trafficAt: null,
          trafficSeq: null,
          trafficRev: null,
          healthRev: rev,
        } as ProviderRow;
        rows.set(id, next);
        return Promise.resolve(next);
      },
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

  it('captures a provider capability claim, and clears a stale one on a claimless sync', async () => {
    // honest-model-capabilities: the claim follows the SAME freshness rule as the
    // listed price — written for every admitted model on every sync, set or
    // cleared — so a later claimless response cannot leave a stale capability
    // attached to the id.
    const { port, upsert } = makePort();
    const seed = mkProvidersService(port, factory(), runtime('selfhosted'));
    const prov = await seed.create(principal, {
      ...baseCreate,
      kind: 'custom',
      baseUrl: 'https://1.1.1.1/v1',
      credential: 'k',
    });
    const withClaim: ProviderModelInfo[] = [
      {
        id: 'm1',
        // States vision and denies tools; says NOTHING about reasoning.
        capabilities: { supportsVision: true, supportsTools: false, contextWindow: 128_000 },
      },
    ];
    const svc = (listing: ProviderModelInfo[]) =>
      mkProvidersService(
        port,
        factory({ listModels: () => Promise.resolve(listing) }),
        runtime('selfhosted'),
      );

    await svc(withClaim).syncModels(principal, prov.id);
    const captured = upsert.mock.calls.at(-1)![2];
    expect(captured).toMatchObject({
      listedSupportsVision: true,
      listedSupportsTools: false, // the provider's asserted negative is real information
      listedContextWindow: 128_000,
    });
    // Silence stays null — never coerced into a denial.
    expect(captured.listedSupportsReasoning).toBeNull();
    expect(captured.listedCapabilitiesCapturedAt).toBeInstanceOf(Date);

    // A later sync that states nothing CLEARS the claim rather than preserving it.
    upsert.mockClear();
    await svc([{ id: 'm1' }]).syncModels(principal, prov.id);
    const cleared = upsert.mock.calls.at(-1)![2];
    expect(cleared).toMatchObject({
      listedSupportsTools: null,
      listedSupportsVision: null,
      listedSupportsReasoning: null,
      listedContextWindow: null,
      listedCapabilitiesCapturedAt: null,
    });
  });

  it('derives the variant for an aggregator provider and clears it when the id stops yielding one', async () => {
    // add-model-variant-detection: written on EVERY sync, set or cleared, so a
    // classification can never outlive the id that produced it.
    const { port, upsert } = makePort();
    const seed = mkProvidersService(port, factory(), runtime('selfhosted'));
    const prov = await seed.create(principal, {
      ...baseCreate,
      kind: 'api_key',
      baseUrl: 'https://openrouter.ai/api/v1',
      credential: 'k',
    });
    const svc = (listing: ProviderModelInfo[]) =>
      mkProvidersService(
        port,
        factory({ listModels: () => Promise.resolve(listing) }),
        runtime('selfhosted'),
      );

    await svc([{ id: 'openai/gpt-6-astra:batch' }, { id: 'openai/gpt-6-astra' }]).syncModels(
      principal,
      prov.id,
    );
    expect(upsert.mock.calls[0]![2].variant).toBe('batch');
    expect(upsert.mock.calls[1]![2].variant).toBeNull();

    upsert.mockClear();
    // The same row, now listed without the suffix: the column is CLEARED, not left.
    await svc([{ id: 'openai/gpt-6-astra' }]).syncModels(principal, prov.id);
    expect(upsert.mock.calls[0]![2].variant).toBeNull();
  });

  it('never classifies a non-aggregator provider, however the id is shaped', async () => {
    const { port, upsert } = makePort();
    const seed = mkProvidersService(port, factory(), runtime('selfhosted'));
    const prov = await seed.create(principal, {
      ...baseCreate,
      kind: 'custom',
      baseUrl: 'https://1.1.1.1/v1',
      credential: 'k',
    });
    const svc = mkProvidersService(
      port,
      factory({ listModels: () => Promise.resolve([{ id: 'openai/gpt-6-astra:batch' }]) }),
      runtime('selfhosted'),
    );
    await svc.syncModels(principal, prov.id);
    // A self-hosted gateway may legitimately serve this id — blocking it would be
    // wrong, not conservative.
    expect(upsert.mock.calls[0]![2].variant).toBeNull();
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
      // capability columns dropped from the model row (honest-model-capabilities)
      isFree: false,
      inputPricePer1m: null,
      outputPricePer1m: null,
      listedInputPricePer1m: 0.3,
      listedOutputPricePer1m: 1.1,
      listedIsFree: false,
      listedPriceCapturedAt: new Date('2026-07-19T00:00:00Z'),
      listedSupportsTools: null,
      listedSupportsVision: null,
      listedSupportsReasoning: null,
      listedContextWindow: null,
      listedCapabilitiesCapturedAt: null,
      variant: null,
      lastSyncedAt: null,
    };
    const nativeRow = {
      id: 'v-native',
      modelKey: 'minimax:minimax-m3',
      inputPricePer1m: 0.3,
      outputPricePer1m: 1.2,
      cacheReadPricePer1m: 0.06,
      cacheWritePricePer1m: null,
      // capability columns dropped from the model row (honest-model-capabilities)
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

describe('batchCapable on the model view (add-batch-mode-routing task 2.3)', () => {
  // Derived server-side from the SUBMISSION predicate, so the dashboard's control and
  // the batch path can never disagree about what is reservable.
  const cases: [string, { kind: string; protocol: string; baseUrl: string | null }, boolean][] = [
    [
      'OpenRouter api-key',
      { kind: 'api_key', protocol: 'openai_compatible', baseUrl: 'https://openrouter.ai/api/v1' },
      true,
    ],
    [
      'Anthropic api-key',
      { kind: 'api_key', protocol: 'anthropic_compatible', baseUrl: 'https://api.anthropic.com' },
      true,
    ],
    [
      'OpenAI api-key',
      { kind: 'api_key', protocol: 'openai_compatible', baseUrl: 'https://api.openai.com/v1' },
      true,
    ],
    // The shape that shipped carrying a seam: identical to the Anthropic row above
    // on family and protocol, separated only by `kind`.
    [
      'Claude subscription',
      {
        kind: 'subscription',
        protocol: 'anthropic_compatible',
        baseUrl: 'https://api.anthropic.com',
      },
      false,
    ],
    [
      'ChatGPT subscription',
      { kind: 'subscription', protocol: 'openai_responses', baseUrl: 'https://chatgpt.com/' },
      false,
    ],
    [
      'local',
      { kind: 'local', protocol: 'openai_compatible', baseUrl: 'http://127.0.0.1:11434/v1' },
      false,
    ],
    [
      'custom',
      { kind: 'custom', protocol: 'openai_compatible', baseUrl: 'https://example.invalid/v1' },
      false,
    ],
    ['no base url', { kind: 'api_key', protocol: 'openai_compatible', baseUrl: null }, false],
  ];

  it.each(cases)('%s -> %s', (_label, provider, expected) => {
    // Exercised through the exported predicate the service delegates to, so this test
    // cannot pass while the service consults something else.
    const seam =
      provider.baseUrl === null
        ? undefined
        : batchFactoryFor({
            kind: provider.kind as never,
            protocol: provider.protocol as never,
            baseUrl: provider.baseUrl,
          });
    expect(seam !== undefined).toBe(expected);
  });
});

describe('batchEffectivePrice on the model read (add-batch-mode-help tasks 1.1/1.2)', () => {
  // Exercised through the shared resolver the service delegates to, so these cannot
  // pass while the service resolves something else.
  const base = {
    providerKind: 'api_key',
    modelInputPricePer1m: 10,
    modelOutputPricePer1m: 30,
    modelIsFree: false,
    listedInputPricePer1m: null,
    listedOutputPricePer1m: null,
    listedIsFree: false,
  };
  const catalogRow = (over: Record<string, unknown> = {}) =>
    ({
      inputPricePer1m: 10,
      outputPricePer1m: 30,
      batchInputPricePer1m: null,
      batchOutputPricePer1m: null,
      isFree: false,
      source: 'catalog',
      ...over,
    }) as never;

  it('resolves the catalog batch pair off the row already fetched', () => {
    const snap = resolveModelPrice(
      base,
      catalogRow({ batchInputPricePer1m: 5, batchOutputPricePer1m: 15 }),
      null,
      { mode: 'batch' },
    );
    expect(snap).toMatchObject({ inputPricePer1m: 5, outputPricePer1m: 15, mode: 'batch' });
  });

  it("falls back to the sibling TWIN's captured rate, flagged as an estimate", () => {
    // The path the first draft of this change would have missed: the rate is on the
    // twin's OWN row, so a resolution passing only the catalog row reports null for
    // exactly the aggregator models whose batch rate is most often knowable.
    const snap = resolveModelPrice(base, catalogRow(), null, {
      mode: 'batch',
      listedBatchInputPricePer1m: 5,
      listedBatchOutputPricePer1m: 15,
    });
    expect(snap).toMatchObject({ inputPricePer1m: 5, outputPricePer1m: 15, source: 'listed' });
  });

  it('is null — never the SYNCHRONOUS rate — when nothing resolves', () => {
    // The failure that would matter most: silently showing the sync price as though it
    // were the batch price would misstate the trade the control exists to disclose.
    const snap = resolveModelPrice(base, catalogRow(), null, { mode: 'batch' });
    expect(snap).toBeNull();
    // ...while the SYNC resolution over the same inputs is not null, so this is a real
    // absence rather than a broken fixture.
    expect(resolveModelPrice(base, catalogRow(), null)).not.toBeNull();
  });

  it('prefers the catalog pair over the twin estimate', () => {
    const snap = resolveModelPrice(
      base,
      catalogRow({ batchInputPricePer1m: 4, batchOutputPricePer1m: 12 }),
      null,
      { mode: 'batch', listedBatchInputPricePer1m: 5, listedBatchOutputPricePer1m: 15 },
    );
    // The catalog pair wins and carries the ROW's source, not the twin's `listed` —
    // which is what proves the estimate did not shadow an authoritative rate.
    expect(snap).toMatchObject({ inputPricePer1m: 4, outputPricePer1m: 12 });
    expect(snap?.source).not.toBe('listed');
  });
});

// The bug: `batchCapable` was derived per PROVIDER, so every model on a batch-capable
// provider inherited it. On OpenRouter batch is a per-model SKU that a minority of the
// catalog carries, so the control appeared on models whose reservation was accepted and
// then refused at submission (fix-batch-capability-and-chain-alignment).
describe('listModels — batchCapable follows the MODEL on an aggregator', () => {
  const prov = (over: Record<string, unknown>) => ({
    ownerUserId: 'u1',
    orgId: null,
    name: 'p',
    kind: 'api_key',
    encryptedCredentials: null,
    status: 'ok',
    oauthPreset: null,
    credentialExpiresAt: null,
    credentialError: null,
    createdAt: new Date(),
    ...over,
  });
  const model = (over: Record<string, unknown>) => ({
    displayName: null,
    // capability columns dropped from the model row (honest-model-capabilities)
    isFree: false,
    inputPricePer1m: null,
    outputPricePer1m: null,
    listedInputPricePer1m: null,
    listedOutputPricePer1m: null,
    listedIsFree: false,
    listedPriceCapturedAt: null,
    listedSupportsTools: null,
    listedSupportsVision: null,
    listedSupportsReasoning: null,
    listedContextWindow: null,
    listedCapabilitiesCapturedAt: null,
    variant: null,
    lastSyncedAt: null,
    ...over,
  });
  const providers = [
    prov({
      id: 'p-or',
      protocol: 'openai_compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
    }),
    prov({
      id: 'p-anth',
      protocol: 'anthropic_compatible',
      baseUrl: 'https://api.anthropic.com',
    }),
    prov({
      id: 'p-local',
      kind: 'local',
      protocol: 'openai_compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
    }),
  ];
  const models = [
    // An aggregator model the catalog DOES sell a batch tier for, and its twin.
    model({ id: 'm-twinned', providerId: 'p-or', externalModelId: 'openai/gpt-6-astra' }),
    model({
      id: 'm-twin',
      providerId: 'p-or',
      externalModelId: 'openai/gpt-6-astra:batch',
      variant: 'batch',
    }),
    // An aggregator model it does not. The seam is identical; the catalog is not.
    model({ id: 'm-bare', providerId: 'p-or', externalModelId: 'minimax/minimax-m3' }),
    // A twin on the SAME provider but for a DIFFERENT model — the pairing must be by
    // base id, not merely "this provider has some twin somewhere".
    model({
      id: 'm-other-twin',
      providerId: 'p-or',
      externalModelId: 'deepseek/deepseek-v4:batch',
      variant: 'batch',
    }),
    // Native: no batch rate in the bundled catalog and no twin convention at all.
    model({ id: 'm-anth', providerId: 'p-anth', externalModelId: 'claude-sonnet-4-5' }),
    model({ id: 'm-local', providerId: 'p-local', externalModelId: 'qwen3' }),
  ];
  /** `prices` seeds the GLOBAL catalog these models resolve against — capability
   * lives there now (honest-model-capabilities), never on the model row. */
  const mkPort = (rows = models, prices: Partial<ModelPriceRow>[] = []) =>
    ({
      providers: { list: () => Promise.resolve(providers) },
      models: { listForPrincipal: () => Promise.resolve(rows) },
      pricing: {
        priceAtMany: (keys: readonly string[]) =>
          Promise.resolve(prices.filter((r) => keys.includes(r.modelKey!))),
      },
    }) as unknown as PersistencePort;
  const byId = (out: { id: string; batchCapable: boolean }[]) =>
    new Map(out.map((m) => [m.id, m.batchCapable]));

  it('requires a sibling twin on the aggregator and nowhere else', async () => {
    const svc = mkProvidersService(mkPort(), factory(), runtime('selfhosted'));
    const flags = byId(await svc.listModels(principal, {}));
    expect(flags.get('m-twinned')).toBe(true);
    // The regression this whole change exists for: same provider, same seam, no SKU.
    expect(flags.get('m-bare')).toBe(false);
    // A native provider that publishes no batch rate is still capable — deriving this
    // from a resolved batch price instead would have made every Anthropic model false.
    expect(flags.get('m-anth')).toBe(true);
    expect(flags.get('m-local')).toBe(false);
    // A non-routable twin is not itself reservable, so it reports false.
    expect(flags.get('m-twin')).toBe(false);
  });

  it('does not let a display filter narrow what the catalog is known to contain', async () => {
    // The twin index fed a display price before it fed a capability; built from the
    // FILTERED rows, `?supportsVision=true` would drop a twin whose flags differ from
    // its base's and report a batchable model as unbatchable — for a reason with nothing
    // to do with batch.
    //
    // honest-model-capabilities: the vehicle changed — capability now resolves from
    // the CATALOG rather than a model-row column that never had a writer — but the
    // invariant is identical, so it is still asserted here through catalog rows.
    const rows = [
      model({ id: 'm-vis', providerId: 'p-or', externalModelId: 'openai/gpt-6-astra' }),
      model({
        id: 'm-vis-twin',
        providerId: 'p-or',
        externalModelId: 'openai/gpt-6-astra:batch',
        variant: 'batch',
      }),
      // The mirror case, for the sibling-base index the twin shortcut reads: here the
      // filter keeps the TWIN and drops its base.
      model({ id: 'm-hid', providerId: 'p-or', externalModelId: 'deepseek/deepseek-v4' }),
      model({
        id: 'm-hid-twin',
        providerId: 'p-or',
        externalModelId: 'deepseek/deepseek-v4:batch',
        variant: 'batch',
      }),
    ];
    const vis = (modelKey: string, supportsVision: boolean): Partial<ModelPriceRow> => ({
      modelKey,
      inputPricePer1m: 1,
      outputPricePer1m: 2,
      supportsVision,
      supportsTools: null,
      supportsReasoning: null,
      contextWindow: null,
      maxOutputTokens: null,
      batchInputPricePer1m: null,
      batchOutputPricePer1m: null,
      isFree: false,
    });
    // A base and its twin deliberately DISAGREE on vision, in both directions.
    const svc = mkProvidersService(
      mkPort(rows, [
        vis('openrouter:openai/gpt-6-astra', true),
        vis('openrouter:openai/gpt-6-astra:batch', false),
        vis('openrouter:deepseek/deepseek-v4', false),
        vis('openrouter:deepseek/deepseek-v4:batch', true),
      ]),
      factory(),
      runtime('selfhosted'),
    );
    const out = await svc.listModels(principal, { supportsVision: true });
    expect(out.map((m) => m.id).sort()).toEqual(['m-hid-twin', 'm-vis']);
    expect(out.find((m) => m.id === 'm-vis')?.batchCapable).toBe(true);
    expect(out.find((m) => m.id === 'm-hid-twin')?.baseExternalModelId).toBe(
      'deepseek/deepseek-v4',
    );
  });

  it('matches a capability filter on the RESOLVED value, and never on unknown', async () => {
    const rows = [
      model({ id: 'm-yes', providerId: 'p-or', externalModelId: 'openai/gpt-6-astra' }),
      model({ id: 'm-no', providerId: 'p-or', externalModelId: 'minimax/minimax-m3' }),
      // No catalog row at all -> the ladder answers UNKNOWN for this one.
      model({ id: 'm-unknown', providerId: 'p-or', externalModelId: 'deepseek/deepseek-v4' }),
    ];
    const row = (modelKey: string, supportsTools: boolean | null): Partial<ModelPriceRow> => ({
      modelKey,
      inputPricePer1m: 1,
      outputPricePer1m: 2,
      supportsTools,
      supportsVision: null,
      supportsReasoning: null,
      contextWindow: null,
      maxOutputTokens: null,
      batchInputPricePer1m: null,
      batchOutputPricePer1m: null,
      isFree: false,
    });
    const port = mkPort(rows, [
      row('openrouter:openai/gpt-6-astra', true),
      row('openrouter:minimax/minimax-m3', false),
    ]);
    const svc = mkProvidersService(port, factory(), runtime('selfhosted'));

    // Before this change these filters ran against a model-row column no code
    // path ever wrote, so BOTH of them matched nothing for every tenant.
    expect((await svc.listModels(principal, { supportsTools: true })).map((m) => m.id)).toEqual([
      'm-yes',
    ]);
    // `false` means ASSERTED false — the unknown model is not a negative answer.
    expect((await svc.listModels(principal, { supportsTools: false })).map((m) => m.id)).toEqual([
      'm-no',
    ]);
    // Unfiltered, the unknown model is present and simply carries no flag.
    const all = await svc.listModels(principal, {});
    expect(all.map((m) => m.id).sort()).toEqual(['m-no', 'm-unknown', 'm-yes']);
    expect(all.find((m) => m.id === 'm-unknown')).not.toHaveProperty('supportsTools');
  });
});
