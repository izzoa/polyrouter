import Redis from 'ioredis';
import {
  InMemoryBreakerStore,
  RedisBreakerStore,
  type BreakerConfig,
  type BreakerOutcome,
  type BreakerStore,
} from './breaker';

const REDIS_URL = process.env['REDIS_URL'];
const cfg: BreakerConfig = {
  threshold: 3,
  cooldownMs: 1000,
  probeLeaseMs: 200,
  stateTtlMs: 10_000,
};

// The pure-transition and shared-InMemory suites prove the state machine
// everywhere; this suite pins the Lua to it against a real Redis. It is gated on
// REDIS_URL for local runs, but in CI it MUST run (ci-pipeline spec: env-gated
// suites fail loudly when their infrastructure is missing, never silently skip).
if (REDIS_URL === undefined && process.env['CI'] !== undefined) {
  throw new Error(
    '[breaker-redis] CI is set but REDIS_URL is missing — the real-Redis parity/concurrency ' +
      'suite is required in CI. Provision a redis service and export REDIS_URL ' +
      '(e.g. redis://127.0.0.1:6379); see .github/workflows/ci.yml.',
  );
}
const suite = REDIS_URL !== undefined ? describe : describe.skip;
if (REDIS_URL === undefined) {
  console.warn(
    '[breaker-redis] REDIS_URL not set — skipping the real-Redis parity/concurrency suite',
  );
}

interface Step {
  readonly now: number;
  readonly outcome?: BreakerOutcome; // apply after the decide
}

async function runSequence(store: BreakerStore, pid: string, steps: readonly Step[]) {
  const decisions: { decision: string; isProbe: boolean }[] = [];
  for (const step of steps) {
    const a = await store.decide(pid, step.now, cfg);
    decisions.push({ decision: a.decision, isProbe: a.isProbe });
    if (a.decision === 'allow' && step.outcome !== undefined) {
      await store.complete(pid, a.generation, step.outcome, step.now, cfg);
    }
  }
  return decisions;
}

suite('RedisBreakerStore against real Redis', () => {
  let redis: Redis;
  const prefix = `test:cb:${String(Date.now())}:`;

  beforeAll(() => {
    redis = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1, lazyConnect: false });
  });
  afterAll(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it('matches the TS transition decision-for-decision (parity)', async () => {
    const steps: Step[] = [
      { now: 0, outcome: 'trip' },
      { now: 0, outcome: 'trip' },
      { now: 0, outcome: 'trip' }, // opens
      { now: 0 }, // skip (open)
      { now: 500 }, // skip
      { now: 1000, outcome: 'success' }, // half-open probe → closes
      { now: 1000 }, // allow (closed)
    ];
    const mem = new InMemoryBreakerStore();
    const red = new RedisBreakerStore(redis, prefix);
    const memDecisions = await runSequence(mem, 'parity', steps);
    const redDecisions = await runSequence(red, 'parity', steps);
    expect(redDecisions).toEqual(memDecisions);
  });

  it('admits exactly one concurrent half-open probe', async () => {
    const red = new RedisBreakerStore(redis, prefix);
    const pid = 'concurrent';
    for (let i = 0; i < cfg.threshold; i++) {
      const a = await red.decide(pid, 0, cfg);
      await red.complete(pid, a.generation, 'trip', 0, cfg);
    }
    const admissions = await Promise.all(
      Array.from({ length: 8 }, () => red.decide(pid, 1000, cfg)),
    );
    expect(admissions.filter((a) => a.decision === 'allow')).toHaveLength(1);
  });
});
