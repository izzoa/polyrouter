// add-live-subscription-models (task 4.3): the model-catalog refresh's scheduler never
// gates boot — an unreachable Redis defers its registration with a warning and a
// retry — registers exactly one hourly job scheduler on its OWN queue, and shuts down
// bounded. bullmq is mocked so these are real assertions about the scheduler itself.
import { Logger } from '@nestjs/common';
import type { PersistenceMaintenance } from '@polyrouter/shared/server';
import type Redis from 'ioredis';
import { ModelCatalogScheduler } from './model-catalog.scheduler';
import type { ProvidersService } from './providers.service';

const state = {
  upserts: [] as unknown[][],
  queues: [] as string[],
  failUpsert: false,
  workers: 0,
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
    constructor() {
      state.workers += 1;
    }
    on(): void {}
    close(): Promise<void> {
      // A worker blocked on an unreachable Redis never finishes closing.
      return state.hangClose ? new Promise<void>(() => undefined) : Promise.resolve();
    }
  }
  return { Queue, Worker };
});

function fakeRedis(): Redis {
  const conn = { on: () => conn, status: 'ready', disconnect: () => undefined };
  return { duplicate: () => conn } as unknown as Redis;
}

const build = (): ModelCatalogScheduler =>
  new ModelCatalogScheduler(fakeRedis(), {} as PersistenceMaintenance, {} as ProvidersService);

describe('ModelCatalogScheduler (add-live-subscription-models)', () => {
  beforeEach(() => {
    state.upserts = [];
    state.queues = [];
    state.failUpsert = false;
    state.workers = 0;
    state.hangClose = false;
  });

  it('registers one hourly job scheduler on its own queue and always runs a worker', async () => {
    const s = build();
    s.onApplicationBootstrap();
    await new Promise((r) => setImmediate(r));
    expect(state.workers).toBe(1);
    // Its own queue — never the OAuth sweep's (which calls token endpoints only).
    expect(state.queues).toEqual(['model-catalog-refresh']);
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0]![0]).toBe('model-catalog-every-60m');
    expect(state.upserts[0]![1]).toEqual({ every: 60 * 60 * 1000 });
    await s.onApplicationShutdown();
  });

  it('an unreachable Redis never blocks boot: registration is deferred with a warning and retried', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      state.failUpsert = true;
      const s = build();
      expect(s.onApplicationBootstrap()).toBeUndefined(); // returns at once — boot proceeds
      await jest.advanceTimersByTimeAsync(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('model catalog scheduler reconcile deferred'),
      );
      // Redis comes back: the retry registers the scheduler.
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
});
