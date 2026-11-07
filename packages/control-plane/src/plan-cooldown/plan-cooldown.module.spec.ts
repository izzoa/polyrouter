// classify-plan-quota-errors task 6.3: the shared store is bounded (an `eval` that never
// settles degrades within the 150 ms fail-fast race), meters its faults, and is ONE instance.
import { Test, type TestingModule } from '@nestjs/testing';
import { FailoverPlanCooldownStore, type PlanCooldownStore } from '@polyrouter/data-plane';
import { REDIS_CLIENT } from '@polyrouter/shared/server';
import { ProxyMetrics } from '../observability/proxy-metrics';
import { BREAKER_REDIS_TIMEOUT_MS } from '../proxy/proxy.config';
import { PLAN_COOLDOWN_STORE, PlanCooldownModule } from './plan-cooldown.module';

describe('PlanCooldownModule', () => {
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
    moduleRef = await Test.createTestingModule({ imports: [PlanCooldownModule] })
      .overrideProvider(REDIS_CLIENT)
      .useValue(hungRedis)
      .compile();
  });
  afterEach(async () => {
    jest.useRealTimers();
    await moduleRef.close();
  });

  it('provides one failover store, and the same object on every lookup', () => {
    const a = moduleRef.get<PlanCooldownStore>(PLAN_COOLDOWN_STORE);
    const b = moduleRef.get<PlanCooldownStore>(PLAN_COOLDOWN_STORE);
    expect(a).toBeInstanceOf(FailoverPlanCooldownStore);
    expect(b).toBe(a);
  });

  it('an eval that never settles still settles check, record and lift within the bound', async () => {
    jest.useFakeTimers();
    const store = moduleRef.get<PlanCooldownStore>(PLAN_COOLDOWN_STORE);
    const metrics = moduleRef.get(ProxyMetrics);
    const faults = jest.spyOn(metrics, 'breakerStoreDegraded');

    // check: answers from the (empty) fallback once the race times out.
    const checked = store.check('p1');
    await jest.advanceTimersByTimeAsync(BREAKER_REDIS_TIMEOUT_MS);
    await expect(checked).resolves.toBeNull();
    expect(faults).toHaveBeenCalledTimes(1);

    // record: lands in the fallback, so the next check (still degraded) sees it.
    const recorded = store.record('p1', { kind: 'quota_exhausted', default: 15 * 60_000 });
    await jest.advanceTimersByTimeAsync(BREAKER_REDIS_TIMEOUT_MS);
    const rec = await recorded;
    expect(rec.kind).toBe('quota_exhausted');
    expect(faults).toHaveBeenCalledTimes(2);

    const again = store.check('p1');
    await jest.advanceTimersByTimeAsync(BREAKER_REDIS_TIMEOUT_MS);
    await expect(again).resolves.toMatchObject({ kind: 'quota_exhausted', until: rec.until });
    expect(faults).toHaveBeenCalledTimes(3);

    // lift: the shared DEL times out, so it REJECTS (never a silent 204) after clearing the fallback.
    const lifted = store.lift('p1');
    const settled = lifted.then(
      () => 'resolved',
      () => 'rejected',
    );
    await jest.advanceTimersByTimeAsync(BREAKER_REDIS_TIMEOUT_MS);
    await expect(settled).resolves.toBe('rejected');
    expect(faults).toHaveBeenCalledTimes(4);

    const afterLift = store.check('p1');
    await jest.advanceTimersByTimeAsync(BREAKER_REDIS_TIMEOUT_MS);
    await expect(afterLift).resolves.toBeNull(); // the fallback record was cleared
    expect(evals).toBe(5);
  });

  it('checkMany is bounded the same way', async () => {
    jest.useFakeTimers();
    const store = moduleRef.get<PlanCooldownStore>(PLAN_COOLDOWN_STORE);
    const many = store.checkMany(['a', 'b']);
    await jest.advanceTimersByTimeAsync(BREAKER_REDIS_TIMEOUT_MS);
    const m = await many;
    expect([...m.entries()]).toEqual([
      ['a', null],
      ['b', null],
    ]);
  });
});
