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
  };
  const port = { pricing } as unknown as PersistencePort;
  const facilities = {
    withAdvisoryLock: <T>(_key: number, fn: (tx: PersistencePort) => Promise<T>) => fn(port),
    withTransaction: <T>(fn: (tx: PersistencePort) => Promise<T>) => fn(port),
  } as unknown as PersistenceFacilities;
  return { versions, port, facilities };
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
    };
    const known = await svc.resolveForModel(model, 'https://api.openai.com/v1', 'api_key', AT);
    expect(known).toMatchObject({ source: 'bundled', inputPricePer1m: 2.5 });
    const reseller = await svc.resolveForModel(model, 'https://reseller.example/v1', 'api_key', AT);
    expect(reseller).toBeNull(); // unknown host → no wrong price
    const local = await svc.resolveForModel(model, 'http://127.0.0.1:11434', 'local', AT);
    expect(local).toMatchObject({ source: 'local', inputPricePer1m: 0 });
  });
});
