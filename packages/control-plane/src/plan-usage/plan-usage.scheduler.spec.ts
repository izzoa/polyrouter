// add-subscription-usage-history (task 3.2): the plan-usage schedule never gates boot — an
// unreachable Redis defers its registration with a warning and a retry — registers exactly one
// 15-minute job scheduler on its OWN queue, wires its tick to the real collaborators, and shuts
// down bounded. bullmq is mocked so these are real assertions about the scheduler itself.
import { Logger } from '@nestjs/common';
import type { PlanUsageStore } from '@polyrouter/data-plane';
import type { PersistenceMaintenance } from '@polyrouter/shared/server';
import type Redis from 'ioredis';
import type { ProvidersService } from '../providers/providers.service';
import {
  PLAN_USAGE_SCHEDULE_EVERY_MS,
  PLAN_USAGE_SCHEDULE_OPTIONS,
  PlanUsageScheduler,
} from './plan-usage.scheduler';

const state = {
  upserts: [] as unknown[][],
  queues: [] as string[],
  workers: [] as string[],
  failUpsert: false,
  hangClose: false,
};

jest.mock('bullmq', () => {
  class Queue {
    constructor(name: string) {
      state.queues.push(name);
    }
    upsertJobScheduler(...args: unknown[]): Promise<void> {
      state.upserts.push(args);
      return state.failUpsert
        ? Promise.reject(new Error('connect ECONNREFUSED'))
        : Promise.resolve();
    }
    on(): void {}
    close(): Promise<void> {
      return Promise.resolve();
    }
  }
  class Worker {
    constructor(name: string) {
      state.workers.push(name);
    }
    on(): void {}
    close(): Promise<void> {
      return state.hangClose ? new Promise<void>(() => undefined) : Promise.resolve();
    }
  }
  return { Queue, Worker };
});

interface FakeRedis {
  duplicate: () => unknown;
  mget: jest.Mock;
  set: jest.Mock;
  get: jest.Mock;
}

function fakeRedis(over: Partial<FakeRedis> = {}): Redis {
  const conn = { on: () => conn, status: 'ready', disconnect: () => undefined };
  return {
    duplicate: () => conn,
    mget: jest.fn(() => Promise.resolve([])),
    set: jest.fn(() => Promise.resolve('OK')),
    get: jest.fn(() => Promise.resolve(null)),
    ...over,
  } as unknown as Redis;
}

const build = (
  redis: Redis = fakeRedis(),
  store: Partial<PlanUsageStore> = {},
  queueName?: string,
): PlanUsageScheduler =>
  new PlanUsageScheduler(
    redis,
    {} as PersistenceMaintenance,
    {} as ProvidersService,
    store as PlanUsageStore,
    queueName,
  );

describe('PlanUsageScheduler (add-subscription-usage-history)', () => {
  beforeEach(() => {
    state.upserts = [];
    state.queues = [];
    state.workers = [];
    state.failUpsert = false;
    state.hangClose = false;
  });

  it('registers one 15-minute job scheduler on its own queue and always runs a worker', async () => {
    const s = build();
    s.onApplicationBootstrap();
    await new Promise((r) => setImmediate(r));
    // Its own queue: never the OAuth sweep's (token endpoints only) nor the catalog's.
    expect(state.queues).toEqual(['plan-usage-schedule']);
    expect(state.workers).toEqual(['plan-usage-schedule']);
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0]![0]).toBe('plan-usage-every-15m');
    expect(state.upserts[0]![1]).toEqual({ every: 15 * 60 * 1000 });
    expect(PLAN_USAGE_SCHEDULE_EVERY_MS).toBe(900_000);
    await s.onApplicationShutdown();
  });

  it('the documented constants: budget 40, 4 at a time, 20 s per row, at most 2 s of jitter, 35 days kept', () => {
    expect(PLAN_USAGE_SCHEDULE_OPTIONS).toMatchObject({
      budget: 40,
      concurrency: 4,
      perRowDeadlineMs: 20_000,
      jitterMaxMs: 2_000,
      retentionMs: 35 * 24 * 60 * 60 * 1000,
      pruneBatch: 5_000,
    });
    // A row read on one tick is stale again by the next one (15 minutes later).
    expect(PLAN_USAGE_SCHEDULE_OPTIONS.freshTtlMs).toBeLessThan(PLAN_USAGE_SCHEDULE_EVERY_MS);
    expect(PLAN_USAGE_SCHEDULE_OPTIONS.tickBudgetMs).toBeLessThan(PLAN_USAGE_SCHEDULE_EVERY_MS);
  });

  it('an injected queue name isolates the queue (the e2e seam)', async () => {
    const s = build(fakeRedis(), {}, 'plan-usage-schedule-e2e-1');
    expect(state.queues).toEqual(['plan-usage-schedule-e2e-1']);
    await s.onApplicationShutdown();
  });

  it('an unreachable Redis never blocks boot: registration is deferred with a warning and retried', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      state.failUpsert = true;
      const s = build();
      expect(s.onApplicationBootstrap()).toBeUndefined();
      await jest.advanceTimersByTimeAsync(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('plan usage scheduler reconcile deferred'),
      );
      state.failUpsert = false;
      await jest.advanceTimersByTimeAsync(60_000);
      expect(state.upserts.length).toBeGreaterThanOrEqual(2);
      await s.onApplicationShutdown();
    } finally {
      warn.mockRestore();
      jest.useRealTimers();
    }
  });

  it('shutdown is bounded: a worker that never finishes closing cannot hang it (invariant 12)', async () => {
    jest.useFakeTimers();
    try {
      state.hangClose = true;
      const s = build();
      let done = false;
      const shutdown = s.onApplicationShutdown().then(() => {
        done = true;
      });
      await jest.advanceTimersByTimeAsync(1_000);
      expect(done).toBe(false);
      await jest.advanceTimersByTimeAsync(1_500);
      await shutdown;
      expect(done).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('the tick deps: an unreadable freshness cache reads as all fresh, and keys carry ids only', async () => {
    const redis = fakeRedis({ mget: jest.fn(() => Promise.reject(new Error('down'))) });
    const s = build(redis);
    const deps = s.tickDeps();
    await expect(deps.freshAmong(['a', 'b'])).resolves.toEqual(new Set(['a', 'b']));
    await deps.markFresh('a', 1_000);
    expect((redis.set as unknown as jest.Mock).mock.calls[0]).toEqual([
      'plan-usage-sched:a',
      '1',
      'PX',
      1_000,
    ]);
    await s.onApplicationShutdown();
    // Shutdown stops the tick between rows.
    expect(deps.shouldStop()).toBe(true);
  });

  it('the tick deps: snapshots come from ONE batched store read, without asking for cooldowns', async () => {
    const readMany = jest.fn(() =>
      Promise.resolve(
        new Map([['a', { snapshot: { windows: [], billing: null }, cooldownEndsAt: null }]]),
      ),
    );
    const s = build(fakeRedis(), { readMany } as unknown as Partial<PlanUsageStore>);
    const snaps = await s.tickDeps().snapshots(['a', 'b']);
    expect(readMany).toHaveBeenCalledTimes(1);
    expect(readMany).toHaveBeenCalledWith(['a', 'b']);
    expect(snaps.get('a')).toEqual({ windows: [], billing: null });
    expect(snaps.get('b')).toBeNull();
    await s.onApplicationShutdown();
  });
});
