import { buildPricingSchedulerConfig, type PricingConfig } from './pricing.config';
import { runPricingRefreshOccurrence } from './pricing-refresh.scheduler';

const BASE: PricingConfig = {
  PRICING_REFRESH_URL: 'https://raw.example/litellm.json',
  PRICING_FETCH_TIMEOUT_MS: 1000,
  PRICING_MAX_BYTES: 1_000_000,
  PRICING_REFRESH_SCHED_ENABLED: 'true',
  PRICING_REFRESH_SCHED_CRON: '30 4 * * *',
};

describe('pricing scheduler config (add-pricing-refresh-ui)', () => {
  it('defaults pin the recorded user decision: ON, daily', () => {
    const cfg = buildPricingSchedulerConfig(BASE);
    expect(cfg.configuredEnabled).toBe(true); // default ON — opt-out, not opt-in
    expect(cfg.cron).toBe('30 4 * * *');
  });

  it('opts out with the single flag', () => {
    expect(
      buildPricingSchedulerConfig({ ...BASE, PRICING_REFRESH_SCHED_ENABLED: 'false' })
        .configuredEnabled,
    ).toBe(false);
  });

  it('an invalid cron fails BOOT, not runtime (fail-fast, the budgets precedent)', () => {
    expect(() =>
      buildPricingSchedulerConfig({ ...BASE, PRICING_REFRESH_SCHED_CRON: 'not a cron' }),
    ).toThrow(/not a valid cron/);
  });
});

describe('runPricingRefreshOccurrence', () => {
  it('delegates to the guarded litellm refresh and logs the applied count', async () => {
    const calls: unknown[] = [];
    const logs: string[] = [];
    await runPricingRefreshOccurrence(
      { refresh: (input) => (calls.push(input), Promise.resolve(7)) },
      { log: (m: string) => logs.push(m), warn: () => {} },
    );
    expect(calls).toEqual([{ source: 'litellm' }]);
    expect(logs[0]).toContain('+7');
  });

  it('contains failures — logged, never thrown outward', async () => {
    const warns: string[] = [];
    await expect(
      runPricingRefreshOccurrence(
        { refresh: () => Promise.reject(new Error('source down')) },
        { log: () => {}, warn: (m: string) => warns.push(m) },
      ),
    ).resolves.toBeUndefined();
    expect(warns[0]).toContain('source down');
  });
});

// --- Scheduler construction/registration (r3-Med-5c): bullmq mocked so the
// gating, registration args, retention, and removal-failure retry are REAL
// assertions, not implied by the sibling idiom.
jest.mock('bullmq', () => {
  const upserts: unknown[][] = [];
  const removals: { fail: boolean }[] = [];
  let removeShouldFail = false;
  class Queue {
    upsertJobScheduler(...args: unknown[]): Promise<void> {
      upserts.push(args);
      return Promise.resolve();
    }
    removeJobScheduler(): Promise<boolean> {
      removals.push({ fail: removeShouldFail });
      return removeShouldFail ? Promise.reject(new Error('redis down')) : Promise.resolve(false);
    }
    on(): void {}
    close(): Promise<void> {
      return Promise.resolve();
    }
  }
  class Worker {
    static constructed = 0;
    constructor() {
      Worker.constructed += 1;
    }
    on(): void {}
    close(): Promise<void> {
      return Promise.resolve();
    }
  }
  return {
    Queue,
    Worker,
    __test: {
      upserts,
      removals,
      setRemoveShouldFail: (v: boolean) => (removeShouldFail = v),
      resetWorker: () => (Worker.constructed = 0),
      workerCount: () => Worker.constructed,
    },
  };
});

interface BullmqTestHooks {
  upserts: unknown[][];
  removals: { fail: boolean }[];
  setRemoveShouldFail: (v: boolean) => void;
  resetWorker: () => void;
  workerCount: () => number;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bullmqTest = (require('bullmq') as { __test: BullmqTestHooks }).__test;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PricingRefreshScheduler } =
  require('./pricing-refresh.scheduler') as typeof import('./pricing-refresh.scheduler');

const fakeRedis = {
  duplicate: () => ({
    on: () => {},
    status: 'ready',
    connect: () => Promise.resolve(),
    disconnect: () => {},
  }),
} as never;
const fakePricing = { refresh: () => Promise.resolve(0) } as never;
const runtimeOf = (mode: string) =>
  ({ mode, refreshUrl: 'https://x', timeoutMs: 1, maxBytes: 1 }) as never;
const schedCfg = (enabled: boolean) => ({ configuredEnabled: enabled, cron: '30 4 * * *' });
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('PricingRefreshScheduler construction + registration (mocked bullmq)', () => {
  beforeEach(() => {
    bullmqTest.upserts.length = 0;
    bullmqTest.removals.length = 0;
    bullmqTest.setRemoveShouldFail(false);
    bullmqTest.resetWorker();
  });

  it('selfhosted + enabled: constructs the worker and registers with UTC + bounded retention', async () => {
    const s = new PricingRefreshScheduler(
      fakeRedis,
      fakePricing,
      runtimeOf('selfhosted'),
      schedCfg(true),
    );
    s.onApplicationBootstrap();
    await settle();
    expect(bullmqTest.workerCount()).toBe(1);
    expect(bullmqTest.upserts).toHaveLength(1);
    const [, repeat, job] = bullmqTest.upserts[0]! as [
      string,
      { pattern: string; tz: string },
      { opts: { removeOnComplete: unknown; removeOnFail: unknown } },
    ];
    expect(repeat).toEqual({ pattern: '30 4 * * *', tz: 'UTC' });
    expect(job.opts.removeOnComplete).toEqual({ age: 3_600 });
    expect(job.opts.removeOnFail).toEqual({ age: 86_400 });
    await s.onApplicationShutdown();
  });

  it('opt-out and cloud both skip the worker and remove any stale schedule', async () => {
    for (const [mode, enabled] of [
      ['selfhosted', false],
      ['cloud', true],
    ] as const) {
      bullmqTest.removals.length = 0;
      bullmqTest.resetWorker();
      const s = new PricingRefreshScheduler(
        fakeRedis,
        fakePricing,
        runtimeOf(mode),
        schedCfg(enabled),
      );
      s.onApplicationBootstrap();
      await settle();
      expect(bullmqTest.workerCount()).toBe(0);
      expect(bullmqTest.removals).toHaveLength(1); // stale schedules retired
      await s.onApplicationShutdown();
    }
  });

  it('a FAILED removal is retried, never swallowed as reconciled (r3-Med-2)', async () => {
    bullmqTest.setRemoveShouldFail(true);
    const s = new PricingRefreshScheduler(
      fakeRedis,
      fakePricing,
      runtimeOf('selfhosted'),
      schedCfg(false),
    );
    s.onApplicationBootstrap();
    await settle();
    expect(bullmqTest.removals).toHaveLength(1);
    // The failure left reconciliation UNDONE: a second bootstrap tick retries
    // (a swallowed error would have marked it reconciled and skipped this).
    bullmqTest.setRemoveShouldFail(false);
    s.onApplicationBootstrap();
    await settle();
    expect(bullmqTest.removals).toHaveLength(2);
    await s.onApplicationShutdown();
  });
});
