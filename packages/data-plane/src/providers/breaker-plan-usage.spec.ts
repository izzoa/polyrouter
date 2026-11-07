// add-subscription-quota-display (task 4.3) — the breaker HOSTS the plan-usage recorder, as it
// hosts the plan cooldown store. The two hooks are synchronous, never throw, and never touch a
// breaker record, so display data can never interfere with admission or health.
import { CircuitBreaker, InMemoryBreakerStore } from './breaker';
import type { PlanUsageObservation } from './plan-usage';
import { InMemoryPlanUsageStore, PlanUsageRecorder, type PlanUsageStore } from './plan-usage-store';

const obs: PlanUsageObservation = {
  windows: [
    {
      key: 'account:5h',
      group: 'account',
      span: '5h',
      minutes: 300,
      scope: null,
      usedPercent: 40,
      reset: null,
    },
  ],
  billing: 'plan',
};

/** A breaker store that counts every call made to it. */
function countingStore(): { store: InMemoryBreakerStore; calls: () => number } {
  const inner = new InMemoryBreakerStore();
  let n = 0;
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const v: unknown = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        n += 1;
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store, calls: () => n };
}

describe('CircuitBreaker plan-usage hooks', () => {
  it('forwards an observation to the hosted recorder, and exposes its cached generation', async () => {
    const store = new InMemoryPlanUsageStore();
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), {
      planUsage: new PlanUsageRecorder(store),
    });
    expect(breaker.planUsageGeneration('p1')).toBe(0);
    breaker.observePlanUsage('p1', obs, 0);
    await new Promise((r) => setImmediate(r));
    const read = (await store.readMany(['p1'])).get('p1')!;
    expect(read.snapshot!.windows[0]!.usedPercent).toBe(40);
    await store.clear('p1');
    // a stale-generation write teaches the recorder the current generation
    breaker.observePlanUsage('p1', { ...obs, billing: 'extra_usage' }, 0);
    await new Promise((r) => setImmediate(r));
    expect(breaker.planUsageGeneration('p1')).toBe(1);
  });

  it('defaults to a recorder over an in-memory store', () => {
    const breaker = new CircuitBreaker(new InMemoryBreakerStore());
    expect(() => breaker.observePlanUsage('p1', obs, 0)).not.toThrow();
    expect(breaker.planUsageGeneration('p1')).toBe(0);
  });

  it('neither method throws, even with a throwing recorder', () => {
    const boom = {
      offer: () => {
        throw new Error('offer exploded');
      },
      generationOf: () => {
        throw new Error('generationOf exploded');
      },
    } as unknown as PlanUsageRecorder;
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), { planUsage: boom });
    expect(() => breaker.observePlanUsage('p1', obs, 0)).not.toThrow();
    expect(breaker.planUsageGeneration('p1')).toBe(0);
  });

  it('neither method reads or writes a breaker record', async () => {
    const { store, calls } = countingStore();
    const usage: PlanUsageStore = new InMemoryPlanUsageStore();
    const breaker = new CircuitBreaker(store, { planUsage: new PlanUsageRecorder(usage) });
    breaker.observePlanUsage('p1', obs, 0);
    breaker.observePlanUsage('p1', { ...obs, billing: 'extra_usage' }, 0);
    breaker.planUsageGeneration('p1');
    await new Promise((r) => setImmediate(r));
    expect(calls()).toBe(0);
    // control: an admission does touch the store, so the counter is live
    await breaker.before('p1');
    expect(calls()).toBeGreaterThan(0);
  });
});
