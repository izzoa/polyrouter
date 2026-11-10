// add-subscription-usage-history tasks 3.2 and 4.1: one tick of the plan-usage schedule, over
// fakes for Redis, Postgres and the read, but the REAL eligibility gates (the providers service's
// `canScheduleUsageRead` / `canSampleUsage` over the bundled preset registries).
import type { PlanUsageSnapshot } from '@polyrouter/data-plane';
import type { PlanUsageSampleInput, PlanUsageScheduleRow } from '@polyrouter/shared/server';
import { ProvidersService } from '../providers/providers.service';
import { CHATGPT_PRESET, CLAUDE_PRESET, OAUTH_PRESETS } from '../subscription-oauth/presets';
import type { OauthPreset } from '../subscription-oauth/presets';
import { SubscriptionOauthService } from '../subscription-oauth/subscription-oauth.service';
import { KIMI_CODE_PRESET } from '../subscription-presets/key-presets';
import {
  runPlanUsageTick,
  samplesFromSnapshot,
  type PlanUsageTickDeps,
  type PlanUsageTickOptions,
} from './plan-usage-tick';
import {
  PlanUsageStoreUnavailableError,
  type UnattendedUsageOutcome,
} from './plan-usage-unattended';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const OPTS: PlanUsageTickOptions = {
  budget: 40,
  concurrency: 4,
  perRowDeadlineMs: 20_000,
  tickBudgetMs: 10 * MIN,
  pageSize: 200,
  jitterMaxMs: 2_000,
  freshTtlMs: 14 * MIN,
  retentionMs: 35 * DAY,
  pruneBatch: 5_000,
  pruneMaxBatches: 20,
};

/** The REAL gates: the service's predicates over the real preset lookup, nothing else wired. */
const oauth = Object.create(SubscriptionOauthService.prototype) as SubscriptionOauthService;
(oauth as unknown as { presets: unknown }).presets = {
  find: (id: string): OauthPreset | undefined => OAUTH_PRESETS.find((p) => p.id === id),
  list: (): readonly OauthPreset[] => OAUTH_PRESETS,
};
const gates = Object.create(ProvidersService.prototype) as ProvidersService;
(gates as unknown as { oauth: unknown }).oauth = oauth;

const KIMI = KIMI_CODE_PRESET.regions[0]!;
let seq = 0;
function row(over: Partial<PlanUsageScheduleRow> & { kindOf?: 'claude' | 'chatgpt' | 'kimi' }) {
  const { kindOf = 'kimi', ...rest } = over;
  seq += 1;
  const base: PlanUsageScheduleRow =
    kindOf === 'claude'
      ? {
          id: '',
          ownerUserId: 'u1',
          kind: 'subscription',
          protocol: CLAUDE_PRESET.protocol,
          baseUrl: CLAUDE_PRESET.baseUrl,
          oauthPreset: CLAUDE_PRESET.id,
          keyPreset: null,
          checkPlanUsage: true,
          credentialError: null,
        }
      : kindOf === 'chatgpt'
        ? {
            id: '',
            ownerUserId: 'u1',
            kind: 'subscription',
            protocol: CHATGPT_PRESET.protocol,
            baseUrl: CHATGPT_PRESET.baseUrl,
            oauthPreset: CHATGPT_PRESET.id,
            keyPreset: null,
            checkPlanUsage: true,
            credentialError: null,
          }
        : {
            id: '',
            ownerUserId: 'u1',
            kind: 'subscription',
            protocol: KIMI.protocol,
            baseUrl: KIMI.baseUrl,
            oauthPreset: null,
            keyPreset: KIMI_CODE_PRESET.id,
            checkPlanUsage: true,
            credentialError: null,
          };
  return { ...base, id: `r${String(seq).padStart(4, '0')}`, ...rest };
}

interface World {
  deps: PlanUsageTickDeps;
  reads: string[];
  fresh: Map<string, number>;
  cursor: { value: string | null };
  db: Map<string, PlanUsageSampleInput>;
  snaps: Map<string, PlanUsageSnapshot>;
  clock: { now: number };
  warnings: string[];
  maxInFlight: () => number;
}

function world(
  rows: PlanUsageScheduleRow[],
  readImpl: (r: PlanUsageScheduleRow) => Promise<UnattendedUsageOutcome> = () =>
    Promise.resolve({ status: 'read', ok: true }),
  over: Partial<PlanUsageTickDeps> = {},
): World {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
  const clock = { now: Date.UTC(2026, 10, 9, 10, 15) };
  const fresh = new Map<string, number>();
  const cursor = { value: null as string | null };
  const db = new Map<string, PlanUsageSampleInput>();
  const snaps = new Map<string, PlanUsageSnapshot>();
  const reads: string[] = [];
  const warnings: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const deps: PlanUsageTickDeps = {
    listPage: (afterId, limit) =>
      Promise.resolve(sorted.filter((r) => afterId === null || r.id > afterId).slice(0, limit)),
    canRead: (r) => gates.canScheduleUsageRead(r),
    canSample: (r) => gates.canSampleUsage(r),
    read: async (r) => {
      reads.push(r.id);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await Promise.resolve();
        return await readImpl(r);
      } finally {
        inFlight -= 1;
      }
    },
    freshAmong: (ids) =>
      Promise.resolve(new Set(ids.filter((id) => (fresh.get(id) ?? 0) > clock.now))),
    markFresh: (id, ttl) => {
      fresh.set(id, clock.now + ttl);
      return Promise.resolve();
    },
    readCursor: () => Promise.resolve(cursor.value),
    writeCursor: (id) => {
      cursor.value = id;
      return Promise.resolve();
    },
    snapshots: (ids) => Promise.resolve(new Map(ids.map((id) => [id, snaps.get(id) ?? null]))),
    // The database's unique key and `ON CONFLICT DO NOTHING`.
    insertSamples: (samples) => {
      let n = 0;
      for (const s of samples) {
        const key = `${s.providerId}|${s.windowKey}|${s.observedAt.toISOString()}`;
        if (db.has(key)) continue;
        db.set(key, s);
        n += 1;
      }
      return Promise.resolve(n);
    },
    prune: (before, limit) => {
      let n = 0;
      for (const [key, s] of db) {
        if (n >= limit) break;
        if (s.observedAt < before) {
          db.delete(key);
          n += 1;
        }
      }
      return Promise.resolve(n);
    },
    sleep: () => Promise.resolve(),
    now: () => clock.now,
    random: () => 0.5,
    shouldStop: () => false,
    warn: (m) => void warnings.push(m),
    ...over,
  };
  return {
    deps,
    reads,
    fresh,
    cursor,
    db,
    snaps,
    clock,
    warnings,
    maxInFlight: () => maxInFlight,
  };
}

const win = (key: string, usedPercent: number | null, observedAt: number) => ({
  key,
  group: 'account' as const,
  span: '5h' as const,
  minutes: 300,
  scope: null,
  usedPercent,
  resetMs: observedAt + 3 * 60 * MIN,
  observedAt,
  source: 'traffic' as const,
});

describe('the usage schedule tick: reads (task 3.2)', () => {
  it('skips the switch-off, reconnect-needed, drifted, API-key and pasted rows without spending budget', async () => {
    const eligible = [row({ kindOf: 'claude' }), row({ kindOf: 'chatgpt' }), row({})];
    const ineligible = [
      row({ checkPlanUsage: false }),
      row({ kindOf: 'claude', credentialError: 'reauthorize_required' }),
      row({ kindOf: 'claude', baseUrl: 'https://proxy.example.test/' }), // drifted
      row({ kind: 'api_key', keyPreset: null }),
      row({ keyPreset: null }), // an "Other subscription" pasted row on a preset host
      row({ kindOf: 'chatgpt', oauthPreset: null }), // pasted on the ChatGPT host
    ];
    // Interleave so a filter that spent budget would starve the eligible rows.
    const w = world([...ineligible, ...eligible]);
    const r = await runPlanUsageTick(w.deps, { ...OPTS, budget: 3 });
    expect(w.reads.sort()).toEqual(eligible.map((e) => e.id).sort());
    expect(r).toMatchObject({ read: 3, failed: 0, skipped: 0, storeUnavailable: false });
    expect(r.examined).toBe(9);
  });

  it('reads at most the budget, then resumes from the cursor on the next tick (wrapping once)', async () => {
    const rows = Array.from({ length: 5 }, () => row({}));
    const w = world(rows);
    await runPlanUsageTick(w.deps, { ...OPTS, budget: 2, concurrency: 1 });
    expect(w.reads).toEqual([rows[0]!.id, rows[1]!.id]);
    expect(w.cursor.value).toBe(rows[1]!.id);
    await runPlanUsageTick(w.deps, { ...OPTS, budget: 2, concurrency: 1 });
    expect(w.reads.slice(2)).toEqual([rows[2]!.id, rows[3]!.id]);
    // The third tick reads the last row, then wraps to the start, where every row is now fresh.
    const third = await runPlanUsageTick(w.deps, { ...OPTS, budget: 2, concurrency: 1 });
    expect(w.reads.slice(4)).toEqual([rows[4]!.id]);
    expect(third.read).toBe(1);
    // A tick 15 minutes later finds every row stale again: one read each, in cursor order.
    w.clock.now += 15 * MIN;
    await runPlanUsageTick(w.deps, OPTS);
    expect(w.reads.slice(5).sort()).toEqual(rows.map((r) => r.id).sort());
  });

  it('a row read within the freshness window is not read again', async () => {
    const rows = [row({}), row({})];
    const w = world(rows);
    await runPlanUsageTick(w.deps, OPTS);
    w.clock.now += 5 * MIN;
    const again = await runPlanUsageTick(w.deps, OPTS);
    expect(w.reads).toHaveLength(2);
    expect(again.read).toBe(0);
    // The freshness lasts the configured TTL from the read.
    expect(w.fresh.get(rows[0]!.id)).toBe(w.clock.now - 5 * MIN + OPTS.freshTtlMs);
  });

  it('a held cooldown skips the row without counting it against the budget', async () => {
    const rows = Array.from({ length: 6 }, () => row({}));
    const held = new Set([rows[0]!.id, rows[1]!.id]);
    const w = world(rows, (r) =>
      Promise.resolve(
        held.has(r.id) ? { status: 'skipped', reason: 'cooldown' } : { status: 'read', ok: true },
      ),
    );
    const r = await runPlanUsageTick(w.deps, { ...OPTS, budget: 3, concurrency: 2 });
    expect(r).toMatchObject({ read: 3, skipped: 2 });
    expect(w.reads).toHaveLength(5);
    // A skipped row is not marked fresh: the next tick tries it again.
    for (const id of held) expect(w.fresh.has(id)).toBe(false);
  });

  it('never runs more than the concurrency at once', async () => {
    const rows = Array.from({ length: 12 }, () => row({}));
    const w = world(
      rows,
      () => new Promise((resolve) => setTimeout(() => resolve({ status: 'read', ok: true }), 5)),
    );
    await runPlanUsageTick(w.deps, OPTS);
    expect(w.reads).toHaveLength(12);
    expect(w.maxInFlight()).toBeLessThanOrEqual(4);
  });

  it('a failed or late read touches nothing else, and the tick goes on', async () => {
    const rows = [row({}), row({}), row({}), row({})];
    const w = world(rows, (r) => {
      if (r.id === rows[0]!.id) return Promise.resolve({ status: 'read', ok: false, kind: 'auth' });
      if (r.id === rows[1]!.id) return Promise.reject(new Error('db down'));
      if (r.id === rows[2]!.id) return new Promise(() => undefined); // never settles
      return Promise.resolve({ status: 'read', ok: true });
    });
    const r = await runPlanUsageTick(w.deps, { ...OPTS, perRowDeadlineMs: 20 });
    expect(r).toMatchObject({ read: 1, failed: 2, timeout: 1 });
    expect(w.reads).toHaveLength(4);
    // Fixed, secret-free warnings only.
    expect(w.warnings).toEqual(
      expect.arrayContaining([
        'plan usage schedule: a usage read failed',
        'plan usage schedule: a usage read passed its deadline',
      ]),
    );
  });

  it('an unreachable store ends the tick: no further read, no sample, no prune', async () => {
    const rows = Array.from({ length: 6 }, () => row({}));
    let inserts = 0;
    let prunes = 0;
    const w = world(rows, () => Promise.reject(new PlanUsageStoreUnavailableError()), {
      insertSamples: () => {
        inserts += 1;
        return Promise.resolve(0);
      },
      prune: () => {
        prunes += 1;
        return Promise.resolve(0);
      },
    });
    const r = await runPlanUsageTick(w.deps, { ...OPTS, concurrency: 1 });
    expect(r.storeUnavailable).toBe(true);
    expect(w.reads).toHaveLength(1);
    expect(inserts + prunes).toBe(0);
    expect(r).toMatchObject({ read: 0, failed: 0, sampled: 0, pruned: 0 });
  });

  it('an unreadable freshness cache reads nothing (never a stampede)', async () => {
    const w = world([row({}), row({})], undefined, {
      freshAmong: () => Promise.reject(new Error('redis down')),
    });
    const r = await runPlanUsageTick(w.deps, OPTS);
    expect(w.reads).toHaveLength(0);
    expect(r.read).toBe(0);
  });

  it('stops starting reads once the tick budget is spent or on shutdown', async () => {
    const rows = Array.from({ length: 5 }, () => row({}));
    let stop = false;
    const w = world(
      rows,
      () => {
        stop = true;
        return Promise.resolve({ status: 'read', ok: true });
      },
      { shouldStop: () => stop },
    );
    const r = await runPlanUsageTick(w.deps, { ...OPTS, concurrency: 1 });
    expect(w.reads).toHaveLength(1);
    expect(r.sampled).toBe(0);
  });
});

describe('the usage schedule tick: history (task 4.1)', () => {
  const T1005 = Date.UTC(2026, 10, 9, 10, 5);

  it('a passive observation at 10:05 is recorded once by the 10:15 tick and not again at 10:30', async () => {
    const p = row({ kindOf: 'claude' });
    const w = world([p], () => Promise.resolve({ status: 'skipped', reason: 'cooldown' }));
    // Traffic updated the 5-hour window at 10:05.
    w.snaps.set(p.id, { windows: [win('account:5h', 42, T1005)], billing: null });
    const first = await runPlanUsageTick(w.deps, OPTS); // the 10:15 tick
    expect(first.sampled).toBe(1);
    expect([...w.db.values()]).toEqual([
      {
        providerId: p.id,
        windowKey: 'account:5h',
        usedPercent: 42,
        resetAt: new Date(T1005 + 3 * 60 * MIN),
        observedAt: new Date(T1005), // the observation's own instant, never the tick's
      },
    ]);
    w.clock.now += 15 * MIN; // the 10:30 tick, no newer observation
    const second = await runPlanUsageTick(w.deps, OPTS);
    expect(second.sampled).toBe(0);
    expect(w.db.size).toBe(1);
    // A newer observation is its own sample.
    w.snaps.set(p.id, { windows: [win('account:5h', 50, T1005 + 30 * MIN)], billing: null });
    w.clock.now += 15 * MIN;
    expect((await runPlanUsageTick(w.deps, OPTS)).sampled).toBe(1);
    expect(w.db.size).toBe(2);
  });

  it('an unknown percent stores null, never 0, and every window is its own sample', () => {
    const samples = samplesFromSnapshot('p1', {
      windows: [
        win('account:5h', null, T1005),
        { ...win('account:weekly', 12, T1005), resetMs: null },
      ],
      billing: { state: 'plan', observedAt: T1005 },
    });
    expect(samples).toEqual([
      expect.objectContaining({ windowKey: 'account:5h', usedPercent: null }),
      expect.objectContaining({ windowKey: 'account:weekly', usedPercent: 12, resetAt: null }),
    ]);
    expect(samplesFromSnapshot('p1', null)).toEqual([]);
  });

  it('samples only rows with the switch on and a usage source; a withdrawn endpoint still samples', async () => {
    const on = row({ kindOf: 'claude' });
    const off = row({ kindOf: 'claude', checkPlanUsage: false });
    const plain = row({ kind: 'api_key', keyPreset: null });
    const w = world([on, off, plain]);
    for (const r of [on, off, plain]) {
      w.snaps.set(r.id, { windows: [win('account:5h', 10, T1005)], billing: null });
    }
    await runPlanUsageTick(w.deps, OPTS);
    expect([...w.db.values()].map((s) => s.providerId)).toEqual([on.id]);
  });

  it('samples every eligible row, beyond the read budget, one batched snapshot read per page', async () => {
    const rows = Array.from({ length: 7 }, () => row({}));
    let batches = 0;
    const w = world(rows, undefined, {
      snapshots: (ids) => {
        batches += 1;
        return Promise.resolve(
          new Map(ids.map((id) => [id, { windows: [win('account:5h', 1, T1005)], billing: null }])),
        );
      },
    });
    const r = await runPlanUsageTick(w.deps, { ...OPTS, budget: 2, pageSize: 3 });
    expect(r.read).toBe(2);
    expect(r.sampled).toBe(7);
    expect(batches).toBe(3); // pages of 3, 3, 1
  });

  it('prunes samples past the retention in bounded batches, at most the batch cap per tick', async () => {
    const p = row({});
    const prunes: Array<{ before: Date; limit: number }> = [];
    const w = world([p], undefined, {
      prune: (before, limit) => {
        prunes.push({ before, limit });
        return Promise.resolve(prunes.length < 3 ? limit : 7);
      },
    });
    const r = await runPlanUsageTick(w.deps, OPTS);
    expect(prunes).toHaveLength(3);
    expect(prunes.every((x) => x.limit === 5_000)).toBe(true);
    expect(prunes[0]!.before.getTime()).toBe(w.clock.now - 35 * DAY);
    expect(r.pruned).toBe(10_007);
    // A table that keeps filling every batch stops at the cap.
    const capped: number[] = [];
    const w2 = world([p], undefined, {
      prune: (_b, limit) => {
        capped.push(limit);
        return Promise.resolve(limit);
      },
    });
    await runPlanUsageTick(w2.deps, { ...OPTS, pruneMaxBatches: 4 });
    expect(capped).toHaveLength(4);
  });

  it('a 36-day-old sample is removed by the prune, a recent one kept', async () => {
    const p = row({});
    const w = world([p]);
    w.db.set('old', {
      providerId: p.id,
      windowKey: 'account:5h',
      usedPercent: 1,
      resetAt: null,
      observedAt: new Date(w.clock.now - 36 * DAY),
    });
    w.db.set('new', {
      providerId: p.id,
      windowKey: 'account:5h',
      usedPercent: 2,
      resetAt: null,
      observedAt: new Date(w.clock.now - 34 * DAY),
    });
    await runPlanUsageTick(w.deps, OPTS);
    expect([...w.db.keys()]).toEqual(['new']);
  });

  it('a failing sample write or prune is contained with a fixed warning', async () => {
    const p = row({});
    const w = world([p], undefined, {
      snapshots: () => Promise.reject(new Error('redis down')),
      prune: () => Promise.reject(new Error('pg down')),
    });
    const r = await runPlanUsageTick(w.deps, OPTS);
    expect(r).toMatchObject({ read: 1, sampled: 0, pruned: 0 });
    expect(w.warnings).toEqual([
      'plan usage schedule: sampling the usage history failed',
      'plan usage schedule: pruning the usage history failed',
    ]);
  });
});
