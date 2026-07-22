import { UnprocessableEntityException } from '@nestjs/common';
import type {
  ModelPriceInput,
  ModelPriceRow,
  PersistenceFacilities,
  PersistencePort,
} from '@polyrouter/shared/server';
import { BUNDLED_PRICES } from './bundled-catalog';
import { PricingService, type PricingFetch, type PricingRuntime } from './pricing.service';

const AT = new Date('2026-08-01T00:00:00Z');

function makeStore() {
  const versions: ModelPriceRow[] = [];
  const runs: { kind: string; added: number; skipped: number }[] = [];
  let seq = 0;
  const desc = (a: ModelPriceRow, b: ModelPriceRow) =>
    b.validFrom.getTime() - a.validFrom.getTime();
  const pricing = {
    priceAt: (key: string, at: Date) =>
      Promise.resolve(
        versions
          .filter((v) => v.modelKey === key && v.validFrom.getTime() <= at.getTime())
          .sort(desc)[0] ?? null,
      ),
    latest: (key: string) =>
      Promise.resolve(versions.filter((v) => v.modelKey === key).sort(desc)[0] ?? null),
    listLatest: (now: Date) => {
      const byKey = new Map<string, ModelPriceRow>();
      for (const v of versions.filter((r) => r.validFrom.getTime() <= now.getTime()).sort(desc)) {
        if (!byKey.has(v.modelKey)) byKey.set(v.modelKey, v);
      }
      return Promise.resolve([...byKey.values()]);
    },
    insertVersion: (entry: ModelPriceInput) => {
      const row: ModelPriceRow = {
        id: `v${++seq}`,
        modelKey: entry.modelKey,
        inputPricePer1m: entry.inputPricePer1m,
        outputPricePer1m: entry.outputPricePer1m,
        cacheReadPricePer1m: entry.cacheReadPricePer1m ?? null,
        cacheWritePricePer1m: entry.cacheWritePricePer1m ?? null,
        contextWindow: entry.contextWindow ?? null,
        supportsTools: entry.supportsTools ?? false,
        supportsVision: entry.supportsVision ?? false,
        supportsReasoning: entry.supportsReasoning ?? false,
        isFree: entry.isFree ?? false,
        source: entry.source,
        validFrom: entry.validFrom,
        createdAt: new Date(),
      };
      versions.push(row);
      return Promise.resolve(row);
    },
    insertRefreshRun: (input: { kind: string; added: number; skipped: number }) => {
      runs.push(input);
      return Promise.resolve();
    },
  };
  const port = { pricing } as unknown as PersistencePort;
  const facilities = {
    // Transactional semantics for the fake (r3-Med-5a): a thrown callback
    // restores both stores, so rollback assertions are REAL, not vacuous.
    withAdvisoryLock: async <T>(_key: number, fn: (tx: PersistencePort) => Promise<T>) => {
      const vSnap = versions.length;
      const rSnap = runs.length;
      try {
        return await fn(port);
      } catch (err) {
        versions.length = vSnap;
        runs.length = rSnap;
        throw err;
      }
    },
    withTransaction: <T>(fn: (tx: PersistencePort) => Promise<T>) => fn(port),
  } as unknown as PersistenceFacilities;
  return { versions, runs, port, facilities };
}

const runtime: PricingRuntime = {
  mode: 'selfhosted',
  refreshUrl: 'https://raw.example/litellm.json',
  timeoutMs: 1000,
  maxBytes: 1_000_000,
};
const noFetch: PricingFetch = () => Promise.reject(new Error('not used'));

describe('PricingService — seed & idempotency', () => {
  it('seeds the bundled catalog once; a second seed is a no-op', async () => {
    const { port, facilities } = makeStore();
    const svc = new PricingService(port, facilities, runtime, noFetch);
    const first = await svc.seed();
    expect(first).toBe(BUNDLED_PRICES.length);
    expect(await svc.seed()).toBe(0);
    const catalog = await svc.listCatalog(AT);
    expect(catalog.length).toBe(BUNDLED_PRICES.length);
    expect(catalog.some((r) => r.isFree)).toBe(true); // curated free set present
  });
});

describe('PricingService — override & manual protection', () => {
  it('appends a manual version and a later seed does not clobber it', async () => {
    const { port, facilities } = makeStore();
    const svc = new PricingService(port, facilities, runtime, noFetch);
    await svc.seed();
    const key = 'openai:gpt-4o';
    await svc.override(key, { inputPricePer1m: 99, outputPricePer1m: 199 }, new Date('2026-09-01'));
    const afterOverride = await svc.priceAt(key, AT); // AT < override date, still bundled
    expect(afterOverride?.source).toBe('bundled');
    const now = await svc.priceAt(key, new Date('2026-09-02'));
    expect(now).toMatchObject({ source: 'manual', inputPricePer1m: 99 });

    // a re-seed must not overwrite the manual override (its latest is manual)
    await svc.seed();
    const stillManual = await svc.priceAt(key, new Date('2026-09-03'));
    expect(stillManual?.source).toBe('manual');
  });

  it('rejects invalid override values', async () => {
    const { port, facilities } = makeStore();
    const svc = new PricingService(port, facilities, runtime, noFetch);
    await expect(
      svc.override('x:y', { inputPricePer1m: -1, outputPricePer1m: 1 }, new Date()),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(
      svc.override('x:y', { inputPricePer1m: 1, outputPricePer1m: 1, isFree: true }, new Date()),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});

describe('PricingService — refresh appends only on change', () => {
  it('a body refresh appends changed rows and no-ops unchanged ones', async () => {
    const { port, facilities } = makeStore();
    const svc = new PricingService(port, facilities, runtime, noFetch);
    await svc.seed();
    // identical to the bundled row → no-op
    const same = await svc.refresh(
      {
        source: 'body',
        entries: [
          {
            modelKey: 'openai:gpt-4o',
            inputPricePer1m: 2.5,
            outputPricePer1m: 10,
            cacheReadPricePer1m: 1.25,
            contextWindow: 128000,
            supportsTools: true,
            supportsVision: true,
          },
        ],
      },
      new Date('2026-09-01'),
    );
    expect(same).toBe(0);
    // changed → appends
    const changed = await svc.refresh(
      {
        source: 'body',
        entries: [{ modelKey: 'openai:gpt-4o', inputPricePer1m: 3, outputPricePer1m: 11 }],
      },
      new Date('2026-09-02'),
    );
    expect(changed).toBe(1);
    expect((await svc.priceAt('openai:gpt-4o', new Date('2026-09-03')))?.inputPricePer1m).toBe(3);
  });

  it('a litellm refresh parses the fetched catalog and appends', async () => {
    const { port, facilities } = makeStore();
    const fetchImpl: PricingFetch = () =>
      Promise.resolve({
        'new-model': {
          litellm_provider: 'openai',
          mode: 'chat',
          input_cost_per_token: 0.000001,
          output_cost_per_token: 0.000002,
        },
      });
    const svc = new PricingService(port, facilities, runtime, fetchImpl);
    const added = await svc.refresh({ source: 'litellm' }, new Date('2026-09-01'));
    expect(added).toBe(1);
    expect(await svc.priceAt('openai:new-model', AT)).toBeNull(); // AT is before the refresh
    expect((await svc.priceAt('openai:new-model', new Date('2026-09-02')))?.inputPricePer1m).toBe(
      1,
    );
  });
});

describe('PricingService — resolveForModel', () => {
  it('resolves a known provider via the catalog and an unknown host to unknown', async () => {
    const { port, facilities } = makeStore();
    const svc = new PricingService(port, facilities, runtime, noFetch);
    await svc.seed();
    const model = {
      externalModelId: 'gpt-4o',
      inputPricePer1m: null,
      outputPricePer1m: null,
      isFree: false,
      listedInputPricePer1m: null,
      listedOutputPricePer1m: null,
      listedIsFree: null,
    };
    const known = await svc.resolveForModel(model, 'https://api.openai.com/v1', 'api_key', AT);
    expect(known).toMatchObject({ source: 'bundled', inputPricePer1m: 2.5 });
    const reseller = await svc.resolveForModel(model, 'https://reseller.example/v1', 'api_key', AT);
    expect(reseller).toBeNull(); // unknown host → no wrong price
    const local = await svc.resolveForModel(model, 'http://127.0.0.1:11434', 'local', AT);
    expect(local).toMatchObject({ source: 'local', inputPricePer1m: 0 });
  });

  it('falls back to the native-family row ONLY on a successful exact-key miss (add-native-price-fallback)', async () => {
    const { port, facilities } = makeStore();
    const svc = new PricingService(port, facilities, runtime, noFetch);
    // Seed ONLY the native-family row — the openrouter channel key is absent.
    await port.pricing.insertVersion({
      modelKey: 'minimax:minimax-m3',
      inputPricePer1m: 0.3,
      outputPricePer1m: 1.2,
      cacheReadPricePer1m: 0.06,
      isFree: false,
      source: 'refresh',
      validFrom: new Date('2026-07-01T00:00:00Z'),
    });
    const model = {
      externalModelId: 'minimax/minimax-m3',
      inputPricePer1m: null,
      outputPricePer1m: null,
      isFree: false,
      listedInputPricePer1m: null,
      listedOutputPricePer1m: null,
      listedIsFree: null,
    };
    const snap = await svc.resolveForModel(model, 'https://openrouter.ai/api/v1', 'api_key', AT);
    expect(snap).toMatchObject({
      source: 'native_family',
      modelKey: 'minimax:minimax-m3',
      inputPricePer1m: 0.3,
      outputPricePer1m: 1.2,
      cacheReadPricePer1m: 0.06,
    });
    // An exact channel row, once appended, WINS for later resolutions (append race:
    // pricing is completion-time — a later `at` sees the exact row).
    await port.pricing.insertVersion({
      modelKey: 'openrouter:minimax/minimax-m3',
      inputPricePer1m: 0.35,
      outputPricePer1m: 1.1,
      isFree: false,
      source: 'refresh',
      validFrom: new Date('2026-08-15T00:00:00Z'),
    });
    const later = await svc.resolveForModel(
      model,
      'https://openrouter.ai/api/v1',
      'api_key',
      new Date('2026-08-16T00:00:00Z'),
    );
    expect(later).toMatchObject({ source: 'refresh', inputPricePer1m: 0.35 });
    // An unmapped vendor never borrows a family price.
    const unmapped = await svc.resolveForModel(
      { ...model, externalModelId: 'somevendor/model-1' },
      'https://openrouter.ai/api/v1',
      'api_key',
      AT,
    );
    expect(unmapped).toBeNull();
  });

  it('a thrown exact lookup PROPAGATES — a DB error is never treated as a catalog miss', async () => {
    const { port, facilities } = makeStore();
    const svc = new PricingService(port, facilities, runtime, noFetch);
    const boom = new Error('pricing db down');
    port.pricing.priceAt = () => Promise.reject(boom);
    await expect(
      svc.resolveForModel(
        {
          externalModelId: 'minimax/minimax-m3',
          inputPricePer1m: null,
          outputPricePer1m: null,
          isFree: false,
          listedInputPricePer1m: null,
          listedOutputPricePer1m: null,
          listedIsFree: null,
        },
        'https://openrouter.ai/api/v1',
        'api_key',
        AT,
      ),
    ).rejects.toBe(boom); // no silent degrade to the native estimate
  });
});

describe('PricingService — refresh validation resilience (A-13)', () => {
  it('a live LiteLLM refresh skips one invalid (negative-price) entry instead of aborting', async () => {
    const { port, facilities } = makeStore();
    // One negative-cost row (invalid) alongside a valid one — a single bad UPSTREAM row
    // must not abort the whole refresh (which would drop the good update too).
    const catalog = {
      'good-model': {
        litellm_provider: 'openai',
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.000008,
      },
      'bad-model': {
        litellm_provider: 'openai',
        input_cost_per_token: -0.001, // negative → invalid
        output_cost_per_token: 0.000008,
      },
    };
    const fetch: PricingFetch = () => Promise.resolve(catalog);
    const svc = new PricingService(port, facilities, runtime, fetch);
    const written = await svc.refresh({ source: 'litellm' }, new Date('2026-09-01'));
    expect(written).toBe(1); // only the good model appended — the bad one skipped, not fatal
    expect(await svc.priceAt('openai:good-model', new Date('2026-09-02'))).not.toBeNull();
    expect(await svc.priceAt('openai:bad-model', new Date('2026-09-02'))).toBeNull();
  });

  it('an admin BODY refresh with an invalid entry fails-fast (operator input surfaced)', async () => {
    const { port, facilities } = makeStore();
    const svc = new PricingService(port, facilities, runtime, noFetch);
    await expect(
      svc.refresh(
        {
          source: 'body',
          entries: [{ modelKey: 'x:y', inputPricePer1m: -1, outputPricePer1m: 1 }],
        },
        new Date(),
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});

describe('PricingService — refresh-run ledger + gates (add-pricing-refresh-ui)', () => {
  it('a litellm pull records a run ATOMICALLY with its counts — incl. a +0 unchanged completion', async () => {
    const { runs, port, facilities } = makeStore();
    const catalog = {
      'gpt-4o': {
        litellm_provider: 'openai',
        mode: 'chat',
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
      },
    };
    const fetch: PricingFetch = () => Promise.resolve(catalog);
    const svc = new PricingService(port, facilities, runtime, fetch);
    const added = await svc.refresh({ source: 'litellm' }, new Date('2026-01-02T00:00:00Z'));
    expect(added).toBe(1);
    expect(runs).toEqual([{ kind: 'litellm', added: 1, skipped: 0 }]);
    // Unchanged repeat: zero versions, but STILL a completed refresh run.
    const again = await svc.refresh({ source: 'litellm' }, new Date('2026-01-03T00:00:00Z'));
    expect(again).toBe(0);
    expect(runs[1]).toEqual({ kind: 'litellm', added: 0, skipped: 0 });
  });

  it('garbage bodies FAIL the run — no ledger row, no versions (r2-Med-4)', async () => {
    for (const body of [{}, [], 'nope', { error: 'x' }]) {
      const { versions, runs, port, facilities } = makeStore();
      const fetch: PricingFetch = () => Promise.resolve(body);
      const svc = new PricingService(port, facilities, runtime, fetch);
      await expect(svc.refresh({ source: 'litellm' }, new Date())).rejects.toThrow(
        /no accepted entries/,
      );
      expect(versions).toHaveLength(0);
      expect(runs).toHaveLength(0);
    }
  });

  it('an endpoint bundled re-apply records a bundled-kind run; boot seed records none', async () => {
    const { runs, port, facilities } = makeStore();
    const svc = new PricingService(port, facilities, runtime, noFetch);
    await svc.seed();
    expect(runs).toHaveLength(0); // boot seeding is not a run
    await svc.refresh({ source: 'bundled' }, new Date());
    expect(runs).toHaveLength(1);
    expect(runs[0]!.kind).toBe('bundled');
  });

  it('a ledger-insert failure rolls back with the versions (atomicity, r2-High-1)', async () => {
    const { versions, port, facilities } = makeStore();
    // Simulate a transactional failure surfacing from the run insert: the
    // whole advisory-lock callback rejects — nothing may be reported applied.
    (port.pricing as unknown as { insertRefreshRun: () => Promise<void> }).insertRefreshRun = () =>
      Promise.reject(new Error('ledger down'));
    const catalog = {
      'gpt-4o': {
        litellm_provider: 'openai',
        mode: 'chat',
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
      },
    };
    const fetch: PricingFetch = () => Promise.resolve(catalog);
    const svc = new PricingService(port, facilities, runtime, fetch);
    await expect(svc.refresh({ source: 'litellm' }, new Date())).rejects.toThrow(/ledger down/);
    // Rollback is REAL: the transactional fake restored both stores — no
    // version survives a failed ledger insert, and no run was recorded.
    expect(versions).toHaveLength(0);
  });

  it('cloud mode refuses refresh and override at the service boundary — seed still works (r2-High-2)', async () => {
    const { port, facilities } = makeStore();
    const cloud: PricingRuntime = { ...runtime, mode: 'cloud' };
    const svc = new PricingService(port, facilities, cloud, noFetch);
    await expect(svc.refresh({ source: 'bundled' }, new Date())).rejects.toThrow(/cloud mode/);
    await expect(
      svc.override('openai:x', { inputPricePer1m: 1, outputPricePer1m: 2 }, new Date()),
    ).rejects.toThrow(/cloud mode/);
    await expect(svc.seed()).resolves.toBeGreaterThan(0); // boot seeding exempt
  });
});
