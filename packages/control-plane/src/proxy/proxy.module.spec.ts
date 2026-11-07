// add-subscription-quota-display task 5.4: the production PROXY_BREAKER factory receives the ONE
// plan-usage recorder, so the breaker, the recorder and an injected consumer of the store all
// share one instance (and with it one per-instance fallback).
import { Inject, Injectable } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  CircuitBreaker,
  FailoverPlanUsageStore,
  type PlanUsageObservation,
  type PlanUsageStore,
} from '@polyrouter/data-plane';
import { REDIS_CLIENT } from '@polyrouter/shared/server';
import { ObservabilityModule } from '../observability/observability.module';
import { RedisModule } from '../redis/redis.module';
import { PlanCooldownModule } from '../plan-cooldown/plan-cooldown.module';
import {
  PLAN_USAGE_RECORDER,
  PLAN_USAGE_STORE,
  PlanUsageModule,
} from '../plan-usage/plan-usage.module';
import { PROXY_BREAKER } from './proxy.config';
import { PROXY_BREAKER_PROVIDER } from './proxy.module';

@Injectable()
class StoreConsumer {
  constructor(@Inject(PLAN_USAGE_STORE) readonly store: PlanUsageStore) {}
}

const OBSERVATION: PlanUsageObservation = {
  windows: [
    {
      key: 'account:5h',
      group: 'account',
      span: '5h',
      minutes: 300,
      scope: null,
      usedPercent: 42,
      reset: { atMs: Date.now() + 3_600_000 },
    },
  ],
  billing: null,
};

describe('ProxyModule plan-usage wiring', () => {
  let moduleRef: TestingModule;
  const quietRedis = {
    status: 'end',
    eval: () => new Promise<never>(() => undefined),
  };

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [RedisModule, ObservabilityModule, PlanCooldownModule, PlanUsageModule],
      providers: [PROXY_BREAKER_PROVIDER, StoreConsumer],
    })
      .overrideProvider(REDIS_CLIENT)
      .useValue(quietRedis)
      .compile();
  });
  afterEach(async () => {
    await moduleRef.close();
  });

  it('builds the breaker with the shared recorder, and provides one store to every consumer', () => {
    const breaker = moduleRef.get<CircuitBreaker>(PROXY_BREAKER);
    expect(breaker).toBeInstanceOf(CircuitBreaker);
    const consumer = moduleRef.get(StoreConsumer);
    const store = moduleRef.get<PlanUsageStore>(PLAN_USAGE_STORE);
    expect(store).toBeInstanceOf(FailoverPlanUsageStore);
    expect(consumer.store).toBe(store);
  });

  it('an observation made on the breaker reaches the shared store exactly once (coalesced)', () => {
    const breaker = moduleRef.get<CircuitBreaker>(PROXY_BREAKER);
    const store = moduleRef.get<PlanUsageStore>(PLAN_USAGE_STORE);
    const merge = jest
      .spyOn(store, 'merge')
      .mockResolvedValue({ applied: true, gen: 3 } as Awaited<ReturnType<PlanUsageStore['merge']>>);

    breaker.observePlanUsage('prov-1', OBSERVATION, 0);
    breaker.observePlanUsage('prov-1', OBSERVATION, 0); // unchanged: the recorder coalesces it
    expect(merge).toHaveBeenCalledTimes(1);
    expect(merge).toHaveBeenCalledWith('prov-1', OBSERVATION, 0, 'traffic');
  });

  it('the breaker and the module hold the same recorder: a generation learned there is read here', async () => {
    const breaker = moduleRef.get<CircuitBreaker>(PROXY_BREAKER);
    const store = moduleRef.get<PlanUsageStore>(PLAN_USAGE_STORE);
    jest
      .spyOn(store, 'merge')
      .mockResolvedValue({ applied: false, gen: 7 } as Awaited<
        ReturnType<PlanUsageStore['merge']>
      >);
    const recorder = moduleRef.get(PLAN_USAGE_RECORDER) as {
      generationOf(id: string): number;
    };

    expect(breaker.planUsageGeneration('prov-9')).toBe(0);
    breaker.observePlanUsage('prov-9', OBSERVATION, 0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(recorder.generationOf('prov-9')).toBe(7);
    expect(breaker.planUsageGeneration('prov-9')).toBe(7);
  });
});
