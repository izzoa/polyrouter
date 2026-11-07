import {
  DEFAULT_PLAN_COOLDOWN_CONFIG as CFG,
  FailoverPlanCooldownStore,
  InMemoryPlanCooldownStore,
  computeUntil,
  planDefaultMs,
} from './plan-cooldown';
import type { PlanCooldown, PlanCooldownInput, PlanCooldownStore } from './plan-cooldown';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('computeUntil (pure maths)', () => {
  const now = 1_000_000_000_000;

  it('the defaults per kind and window (design D4)', () => {
    expect(planDefaultMs('quota_exhausted', 'short')).toBe(15 * MIN);
    expect(planDefaultMs('quota_exhausted', undefined)).toBe(15 * MIN);
    expect(planDefaultMs('quota_exhausted', 'long')).toBe(60 * MIN);
    expect(planDefaultMs('risk_control', undefined)).toBe(30 * MIN);
    expect(planDefaultMs('plan_inactive', undefined)).toBe(60 * MIN);
    expect(CFG.minMs).toBe(MIN);
    expect(CFG.maxMs).toBe(7 * DAY);
  });

  it('abs: a stated reset two hours ahead is kept, recorded as provider-stated', () => {
    expect(computeUntil(now, { kind: 'quota_exhausted', abs: now + 2 * HOUR })).toEqual({
      until: now + 2 * HOUR,
      source: 'provider',
    });
  });

  it('abs: a past reset clamps to 1 minute and a distant one to 7 days', () => {
    expect(computeUntil(now, { kind: 'quota_exhausted', abs: now - HOUR }).until).toBe(now + MIN);
    expect(computeUntil(now, { kind: 'quota_exhausted', abs: 0 }).until).toBe(now + MIN);
    expect(computeUntil(now, { kind: 'quota_exhausted', abs: now + 30 * DAY }).until).toBe(
      now + 7 * DAY,
    );
  });

  it('rel: the duration is added to the store clock, then clamped both ways', () => {
    expect(computeUntil(now, { kind: 'risk_control', rel: 120_000 })).toEqual({
      until: now + 120_000,
      source: 'provider',
    });
    expect(computeUntil(now, { kind: 'risk_control', rel: 0 }).until).toBe(now + MIN);
    expect(computeUntil(now, { kind: 'risk_control', rel: 30_000 }).until).toBe(now + MIN);
    expect(computeUntil(now, { kind: 'risk_control', rel: 90 * DAY }).until).toBe(now + 7 * DAY);
  });

  it('default: now plus the duration, recorded as a polyrouter default', () => {
    expect(computeUntil(now, { kind: 'plan_inactive', default: 60 * MIN })).toEqual({
      until: now + 60 * MIN,
      source: 'default',
    });
  });

  it('honours an overridden config', () => {
    const cfg = { ...CFG, minMs: 10, maxMs: 100 };
    expect(computeUntil(now, { kind: 'quota_exhausted', abs: now + 5 }, cfg).until).toBe(now + 10);
    expect(computeUntil(now, { kind: 'quota_exhausted', rel: 5000 }, cfg).until).toBe(now + 100);
  });

  it('rejects a non-finite input and a non-pausing kind rather than guessing', () => {
    expect(() => computeUntil(now, { kind: 'quota_exhausted', abs: NaN })).toThrow(RangeError);
    expect(() => computeUntil(now, { kind: 'quota_exhausted', rel: Infinity })).toThrow(RangeError);
    expect(() => computeUntil(now, { kind: 'quota_exhausted', default: 0 })).toThrow(RangeError);
    expect(() =>
      computeUntil(now, { kind: 'rate_limit', default: 1 } as unknown as PlanCooldownInput),
    ).toThrow(RangeError);
  });
});

describe('InMemoryPlanCooldownStore', () => {
  let t = 5_000_000;
  const clock = (): number => t;
  beforeEach(() => {
    t = 5_000_000;
  });

  it('records, checks and expires on its own, with no write', async () => {
    const store = new InMemoryPlanCooldownStore(clock);
    expect(await store.check('p')).toBeNull();
    const rec = await store.record('p', { kind: 'quota_exhausted', rel: 10 * MIN });
    expect(rec).toEqual({ kind: 'quota_exhausted', until: t + 10 * MIN, source: 'provider' });
    expect(await store.check('p')).toEqual(rec);
    t += 10 * MIN - 1;
    expect(await store.check('p')).not.toBeNull();
    t += 1;
    expect(await store.check('p')).toBeNull();
  });

  it('is extend-only: an earlier end changes nothing, a later one replaces end AND kind', async () => {
    const store = new InMemoryPlanCooldownStore(clock);
    const first = await store.record('p', { kind: 'plan_inactive', rel: 2 * HOUR });
    const shorter = await store.record('p', { kind: 'quota_exhausted', rel: HOUR });
    expect(shorter).toEqual(first);
    expect(await store.check('p')).toEqual(first);
    const same = await store.record('p', { kind: 'risk_control', rel: 2 * HOUR });
    expect(same.kind).toBe('plan_inactive');
    const later = await store.record('p', { kind: 'risk_control', rel: 3 * HOUR });
    expect(later).toEqual({ kind: 'risk_control', until: t + 3 * HOUR, source: 'provider' });
  });

  it('a record after expiry starts fresh', async () => {
    const store = new InMemoryPlanCooldownStore(clock);
    await store.record('p', { kind: 'plan_inactive', rel: 2 * MIN });
    t += 3 * MIN;
    const next = await store.record('p', { kind: 'quota_exhausted', default: MIN });
    expect(next).toEqual({ kind: 'quota_exhausted', until: t + MIN, source: 'default' });
  });

  it('checkMany answers every id, null where unpaused; lift deletes and is idempotent', async () => {
    const store = new InMemoryPlanCooldownStore(clock);
    await store.record('a', { kind: 'quota_exhausted', rel: HOUR });
    const m = await store.checkMany(['a', 'b']);
    expect(m.get('a')?.kind).toBe('quota_exhausted');
    expect(m.get('b')).toBeNull();
    expect(m.size).toBe(2);
    await store.lift('a');
    await store.lift('a');
    expect(await store.check('a')).toBeNull();
  });

  it('holds only { kind, until, source }', async () => {
    const store = new InMemoryPlanCooldownStore(clock);
    const rec = await store.record('p', { kind: 'quota_exhausted', rel: HOUR });
    expect(Object.keys(rec).sort()).toEqual(['kind', 'source', 'until']);
  });

  it('rejects a malformed input', async () => {
    const store = new InMemoryPlanCooldownStore(clock);
    await expect(store.record('p', { kind: 'quota_exhausted', abs: NaN })).rejects.toThrow(
      RangeError,
    );
  });
});

describe('FailoverPlanCooldownStore', () => {
  const boom = new Error('redis down');
  const rejecting = (): PlanCooldownStore => ({
    check: () => Promise.reject(boom),
    checkMany: () => Promise.reject(boom),
    record: () => Promise.reject(boom),
    lift: () => Promise.reject(boom),
  });

  it('delegates to a healthy primary and never touches the fallback or onError', async () => {
    const primary = new InMemoryPlanCooldownStore();
    const fallback = new InMemoryPlanCooldownStore();
    const onError = jest.fn();
    const store = new FailoverPlanCooldownStore(primary, fallback, onError);
    await store.record('p', { kind: 'quota_exhausted', rel: HOUR });
    expect(await store.check('p')).not.toBeNull();
    expect((await store.checkMany(['p'])).get('p')).not.toBeNull();
    expect(await fallback.check('p')).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('a healthy primary answering null is "no pause": the fallback is not consulted', async () => {
    const fallback = new InMemoryPlanCooldownStore();
    await fallback.record('p', { kind: 'quota_exhausted', rel: HOUR });
    const store = new FailoverPlanCooldownStore(new InMemoryPlanCooldownStore(), fallback);
    expect(await store.check('p')).toBeNull();
  });

  it('a rejecting primary completes check, checkMany, record and lift from the fallback, one onError each', async () => {
    const fallback = new InMemoryPlanCooldownStore();
    const onError = jest.fn();
    const store = new FailoverPlanCooldownStore(rejecting(), fallback, onError);

    expect(await store.check('p')).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);

    const rec = await store.record('p', { kind: 'risk_control', rel: HOUR });
    expect(onError).toHaveBeenCalledTimes(2);
    expect(rec.kind).toBe('risk_control');

    expect((await store.check('p'))?.kind).toBe('risk_control');
    expect(onError).toHaveBeenCalledTimes(3);
    expect((await store.checkMany(['p', 'q'])).get('p')?.kind).toBe('risk_control');
    expect(onError).toHaveBeenCalledTimes(4);

    await expect(store.lift('p')).rejects.toBe(boom);
    expect(onError).toHaveBeenCalledTimes(5);
  });

  it('a failed primary lift clears the fallback record and rejects', async () => {
    const fallback = new InMemoryPlanCooldownStore();
    await fallback.record('p', { kind: 'quota_exhausted', rel: HOUR });
    const store = new FailoverPlanCooldownStore(rejecting(), fallback, () => undefined);
    await expect(store.lift('p')).rejects.toBe(boom);
    expect(await fallback.check('p')).toBeNull();
  });

  it('a healthy lift clears the fallback too', async () => {
    const primary = new InMemoryPlanCooldownStore();
    const fallback = new InMemoryPlanCooldownStore();
    await primary.record('p', { kind: 'quota_exhausted', rel: HOUR });
    await fallback.record('p', { kind: 'quota_exhausted', rel: HOUR });
    const store = new FailoverPlanCooldownStore(primary, fallback);
    await store.lift('p');
    expect(await primary.check('p')).toBeNull();
    expect(await fallback.check('p')).toBeNull();
  });

  it('a throwing onError never breaks the call path', async () => {
    const store = new FailoverPlanCooldownStore(
      rejecting(),
      new InMemoryPlanCooldownStore(),
      () => {
        throw new Error('meter broke');
      },
    );
    await expect(store.check('p')).resolves.toBeNull();
    await expect(store.record('p', { kind: 'plan_inactive', default: MIN })).resolves.toMatchObject(
      {
        kind: 'plan_inactive',
      },
    );
  });

  it('a malformed input is a caller bug, rejected and NOT metered as a store fault', async () => {
    const onError = jest.fn();
    const store = new FailoverPlanCooldownStore(
      new InMemoryPlanCooldownStore(),
      new InMemoryPlanCooldownStore(),
      onError,
    );
    await expect(store.record('p', { kind: 'quota_exhausted', abs: NaN })).rejects.toThrow(
      RangeError,
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it('a hung primary is bounded by whatever wraps it: here a timeout-style rejection', async () => {
    const slow: PlanCooldownStore = {
      ...rejecting(),
      check: () => Promise.reject(new Error('timeout')),
    };
    const onError = jest.fn();
    const store = new FailoverPlanCooldownStore(slow, new InMemoryPlanCooldownStore(), onError);
    const rec: PlanCooldown | null = await store.check('p');
    expect(rec).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
