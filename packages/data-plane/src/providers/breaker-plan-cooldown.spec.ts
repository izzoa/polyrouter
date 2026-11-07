import { CircuitBreaker, InMemoryBreakerStore } from './breaker';
import { ProviderError } from './errors';
import type { ProviderErrorMeta } from './errors';
import type { ProviderErrorKind } from './errors';
import { InMemoryPlanCooldownStore } from './plan-cooldown';
import type { PlanCooldownInput, PlanCooldownStore } from './plan-cooldown';

const MIN = 60_000;

function planError(
  kind: ProviderErrorKind,
  meta: ProviderErrorMeta = { status: 429 },
): ProviderError {
  return new ProviderError(kind, 'm', meta);
}

/** A store that counts every call, delegating to a real in-memory one. */
function spyStore(now: () => number): PlanCooldownStore & {
  record: jest.Mock;
  check: jest.Mock;
  inputs: PlanCooldownInput[];
} {
  const inner = new InMemoryPlanCooldownStore(now);
  const inputs: PlanCooldownInput[] = [];
  return {
    inputs,
    check: jest.fn((id: string) => inner.check(id)),
    checkMany: (ids: readonly string[]) => inner.checkMany(ids),
    record: jest.fn((id: string, input: PlanCooldownInput) => {
      inputs.push(input);
      return inner.record(id, input);
    }),
    lift: (id: string) => inner.lift(id),
  };
}

const throwingStore = (): PlanCooldownStore => {
  const boom = new Error('store exploded');
  return {
    check: () => Promise.reject(boom),
    checkMany: () => Promise.reject(boom),
    record: () => Promise.reject(boom),
    lift: () => Promise.reject(boom),
  };
};

describe('CircuitBreaker plan cooldown hosting', () => {
  let t = 10_000_000;
  const now = (): number => t;
  beforeEach(() => {
    t = 10_000_000;
  });

  it('defaults to an in-memory store: a recorded pause is read back and expires', async () => {
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), { now });
    expect(await breaker.planCooldownFor('p')).toBeNull();
    await breaker.recordPlanCooldown('p', planError('quota_exhausted'));
    const pause = await breaker.planCooldownFor('p');
    expect(pause).toEqual({ kind: 'quota_exhausted', until: t + 15 * MIN, source: 'default' });
    t += 15 * MIN;
    expect(await breaker.planCooldownFor('p')).toBeNull();
  });

  it('chooses the input: a stated reset, then a relative Retry-After, then the kind default', async () => {
    const store = spyStore(now);
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), { planCooldowns: store, now });
    await breaker.recordPlanCooldown(
      'a',
      planError('quota_exhausted', { status: 429, planReset: { resetAt: t + 2 * 60 * MIN } }),
    );
    await breaker.recordPlanCooldown(
      'b',
      planError('risk_control', { status: 429, planReset: { retryAfterMs: 120_000 } }),
    );
    await breaker.recordPlanCooldown(
      'c',
      planError('quota_exhausted', { status: 429, planReset: { window: 'long' } }),
    );
    await breaker.recordPlanCooldown('d', planError('risk_control'));
    await breaker.recordPlanCooldown('e', planError('plan_inactive'));
    await breaker.recordPlanCooldown('f', planError('quota_exhausted'));
    expect(store.inputs).toEqual([
      { kind: 'quota_exhausted', abs: t + 2 * 60 * MIN },
      { kind: 'risk_control', rel: 120_000 },
      { kind: 'quota_exhausted', default: 60 * MIN },
      { kind: 'risk_control', default: 30 * MIN },
      { kind: 'plan_inactive', default: 60 * MIN },
      { kind: 'quota_exhausted', default: 15 * MIN },
    ]);
  });

  it('a throwing store gives "no pause" and a no-op write, and calls onError', async () => {
    const onError = jest.fn();
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), {
      planCooldowns: throwingStore(),
      onError,
      now,
    });
    await expect(breaker.planCooldownFor('p')).resolves.toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    await expect(
      breaker.recordPlanCooldown('p', planError('quota_exhausted')),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('a throwing onError never escapes either method', async () => {
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), {
      planCooldowns: throwingStore(),
      onError: () => {
        throw new Error('meter broke');
      },
      now,
    });
    await expect(breaker.planCooldownFor('p')).resolves.toBeNull();
    await expect(
      breaker.recordPlanCooldown('p', planError('quota_exhausted')),
    ).resolves.toBeUndefined();
  });

  it('writes nothing for plan_entitlement, rate_limit or any non-pausing kind', async () => {
    const store = spyStore(now);
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), { planCooldowns: store, now });
    for (const kind of [
      'plan_entitlement',
      'rate_limit',
      'unavailable',
      'auth',
      'permission',
      'unknown_model',
    ] as const) {
      await breaker.recordPlanCooldown('p', planError(kind));
    }
    expect(store.record).not.toHaveBeenCalled();
  });

  it('writes nothing for a pausing kind WITHOUT a status (the shape of a skip error)', async () => {
    const store = spyStore(now);
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), { planCooldowns: store, now });
    for (const kind of ['quota_exhausted', 'risk_control', 'plan_inactive'] as const) {
      await breaker.recordPlanCooldown('p', planError(kind, {}));
    }
    expect(store.record).not.toHaveBeenCalled();
    // ...and the same kinds WITH a status do write, so the guard is the status alone.
    await breaker.recordPlanCooldown('p', planError('quota_exhausted'));
    expect(store.record).toHaveBeenCalledTimes(1);
  });

  it('neither method changes a breaker record, generation or lease', async () => {
    const primary = new InMemoryBreakerStore();
    const cfg = { threshold: 3, cooldownMs: 1000, probeLeaseMs: 500, stateTtlMs: 60_000 };
    const breaker = new CircuitBreaker(primary, { config: cfg, now });
    const a = await breaker.before('p');
    expect(a.decision).toBe('allow');
    const before = await primary.decide('p', t, cfg);

    await breaker.planCooldownFor('p');
    await breaker.recordPlanCooldown('p', planError('quota_exhausted'));
    await breaker.recordPlanCooldown('p', planError('plan_inactive'));
    await breaker.planCooldownFor('p');

    const after = await primary.decide('p', t, cfg);
    expect(after).toEqual(before); // same decision, generation and probe state
    // The pre-existing token still completes against the unchanged generation.
    expect(a.token.generation).toBe(before.generation);
  });

  it('a recorded pause does not alter decide results for the breaker itself', async () => {
    const breaker = new CircuitBreaker(new InMemoryBreakerStore(), { now });
    await breaker.recordPlanCooldown('p', planError('plan_inactive'));
    const admission = await breaker.before('p');
    expect(admission.decision).toBe('allow');
    expect(admission.token.isProbe).toBe(false);
  });
});
