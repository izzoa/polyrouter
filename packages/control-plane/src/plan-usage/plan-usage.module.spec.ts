// add-subscription-quota-display task 5.4: the shared store is bounded (an `eval` that never
// settles degrades within the 150 ms fail-fast race), meters its faults, and is ONE instance.
import { Test, type TestingModule } from '@nestjs/testing';
import {
  FailoverPlanUsageStore,
  PlanUsageRecorder,
  readPlanUsage,
  type PlanUsageStore,
} from '@polyrouter/data-plane';
import { REDIS_CLIENT } from '@polyrouter/shared/server';
import { ProxyMetrics } from '../observability/proxy-metrics';
import { BREAKER_REDIS_TIMEOUT_MS } from '../proxy/proxy.config';
import {
  PLAN_USAGE_READER,
  PLAN_USAGE_RECORDER,
  PLAN_USAGE_STORE,
  PlanUsageModule,
} from './plan-usage.module';

describe('PlanUsageModule', () => {
  let moduleRef: TestingModule;
  let evals = 0;
  const hungRedis = {
    status: 'end', // RedisLifecycle skips a closed client at shutdown
    // Never settles: a Redis that accepted the command and went silent.
    eval: () => {
      evals += 1;
      return new Promise<never>(() => undefined);
    },
  };

  beforeEach(async () => {
    evals = 0;
    moduleRef = await Test.createTestingModule({ imports: [PlanUsageModule] })
      .overrideProvider(REDIS_CLIENT)
      .useValue(hungRedis)
      .compile();
  });
  afterEach(async () => {
    jest.useRealTimers();
    await moduleRef.close();
  });

  it('provides one failover store and one recorder, the same object on every lookup', () => {
    const store = moduleRef.get<PlanUsageStore>(PLAN_USAGE_STORE);
    expect(store).toBeInstanceOf(FailoverPlanUsageStore);
    expect(moduleRef.get(PLAN_USAGE_STORE)).toBe(store);
    const recorder = moduleRef.get<PlanUsageRecorder>(PLAN_USAGE_RECORDER);
    expect(recorder).toBeInstanceOf(PlanUsageRecorder);
    expect(moduleRef.get(PLAN_USAGE_RECORDER)).toBe(recorder);
  });

  it('binds the reader to readPlanUsage, a value an e2e suite can override', async () => {
    expect(moduleRef.get(PLAN_USAGE_READER)).toBe(readPlanUsage);
    const fake = jest.fn();
    const overridden = await Test.createTestingModule({ imports: [PlanUsageModule] })
      .overrideProvider(REDIS_CLIENT)
      .useValue(hungRedis)
      .overrideProvider(PLAN_USAGE_READER)
      .useValue(fake)
      .compile();
    try {
      expect(overridden.get(PLAN_USAGE_READER)).toBe(fake);
    } finally {
      await overridden.close();
    }
  });

  it('an eval that never settles still settles readMany within the bound, metered once', async () => {
    jest.useFakeTimers();
    const store = moduleRef.get<PlanUsageStore>(PLAN_USAGE_STORE);
    const metrics = moduleRef.get(ProxyMetrics);
    const faults = jest.spyOn(metrics, 'breakerStoreDegraded');

    const read = store.readMany(['p1']);
    await jest.advanceTimersByTimeAsync(BREAKER_REDIS_TIMEOUT_MS);
    const result = await read;
    // The empty per-instance fallback answers: nothing is known, and nothing hangs.
    expect(result.get('p1')?.snapshot ?? null).toBeNull();
    expect(faults).toHaveBeenCalledTimes(1);
    expect(evals).toBe(1);
  });

  it('claimRefresh never degrades: a hung Redis rejects it (the endpoint answers 503)', async () => {
    jest.useFakeTimers();
    const store = moduleRef.get<PlanUsageStore>(PLAN_USAGE_STORE);
    const settled = store.claimRefresh('p1').then(
      () => 'resolved',
      () => 'rejected',
    );
    await jest.advanceTimersByTimeAsync(BREAKER_REDIS_TIMEOUT_MS);
    await expect(settled).resolves.toBe('rejected');
  });
});
