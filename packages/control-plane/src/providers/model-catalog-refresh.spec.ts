// add-live-subscription-models (task 4.4): the catalog refresh's policy — a bounded,
// round-robin scan, only due rows refreshed, budgeted, each under its own owner,
// failures contained and retried with backoff, and a cache outage never a stampede.
// Pure: no BullMQ, Redis, or Postgres.
import type { CatalogRefreshRow, Principal } from '@polyrouter/shared/server';
import {
  runModelCatalogRefresh,
  type CatalogRefreshDeps,
  type CatalogRefreshOptions,
} from './model-catalog-refresh';

const OPTS: CatalogRefreshOptions = {
  budget: 3,
  concurrency: 2,
  perRowDeadlineMs: 1_000,
  tickBudgetMs: 60_000,
  pageSize: 2,
  jitterMaxMs: 0,
  freshTtlMs: 86_400_000,
  retryTtlMs: 3_600_000,
};

const row = (i: number, owner = 'u1'): CatalogRefreshRow => ({
  id: `p${String(i).padStart(3, '0')}`,
  ownerUserId: owner,
});

function harness(rows: CatalogRefreshRow[], over: Partial<CatalogRefreshDeps> = {}) {
  const fresh = new Set<string>();
  let cursor: string | null = null;
  const failures = new Map<string, number>();
  const scanned: Array<string | null> = [];
  const marks: Array<{ id: string; ttlMs: number }> = [];
  const refreshed: Array<{ principal: Principal; id: string }> = [];
  const warnings: string[] = [];
  const deps: CatalogRefreshDeps = {
    listPage: (afterId, limit) => {
      scanned.push(afterId);
      return Promise.resolve(
        rows.filter((r) => afterId === null || r.id > afterId).slice(0, limit),
      );
    },
    refresh: (principal, id) => {
      refreshed.push({ principal, id });
      return Promise.resolve({ ok: true });
    },
    freshAmong: (ids) => Promise.resolve(new Set(ids.filter((id) => fresh.has(id)))),
    markFresh: (id, ttlMs) => {
      marks.push({ id, ttlMs });
      fresh.add(id);
      return Promise.resolve();
    },
    recordFailure: (id) => {
      const n = (failures.get(id) ?? 0) + 1;
      failures.set(id, n);
      return Promise.resolve(n);
    },
    clearFailures: (id) => {
      failures.delete(id);
      return Promise.resolve();
    },
    readCursor: () => Promise.resolve(cursor),
    writeCursor: (id) => {
      cursor = id;
      return Promise.resolve();
    },
    sleep: () => Promise.resolve(),
    now: () => 0,
    random: () => 0,
    shouldStop: () => false,
    warn: (m) => warnings.push(m),
    ...over,
  };
  return { deps, fresh, marks, refreshed, warnings, failures, scanned };
}

describe('runModelCatalogRefresh (add-live-subscription-models)', () => {
  it('scans only until the budget is full, refreshes only due rows, and resumes there next tick', async () => {
    const rows = [row(1), row(2), row(3), row(4), row(5)];
    const h = harness(rows);
    h.fresh.add('p002'); // refreshed within the freshness window
    const r = await runModelCatalogRefresh(h.deps, OPTS);
    // Budget 3: p001, p003, p004 — the scan stops there; p005 is never even read.
    expect(r).toMatchObject({ examined: 4, due: 3, refreshed: 3, carriedOver: 0 });
    expect(h.refreshed.map((x) => x.id)).toEqual(['p001', 'p003', 'p004']);
    expect(h.marks.every((m) => m.ttlMs === OPTS.freshTtlMs)).toBe(true);
    // The next tick resumes after p004, reaches p005, then wraps (all fresh).
    const again = await runModelCatalogRefresh(h.deps, OPTS);
    expect(again).toMatchObject({ due: 1, refreshed: 1, carriedOver: 0 });
    expect(h.refreshed.at(-1)!.id).toBe('p005');
    expect(new Set(h.refreshed.map((x) => x.id)).size).toBe(4);
  });

  it('the scan is bounded by the tick: it stops paging once time runs out', async () => {
    let clock = 0;
    const rows = Array.from({ length: 50 }, (_, i) => row(i + 1));
    const h = harness(rows, {
      now: () => clock,
      freshAmong: (ids) => {
        clock += OPTS.tickBudgetMs / 4; // each page's cache read is slow
        return Promise.resolve(new Set(ids)); // all fresh: nothing to fill the budget
      },
    });
    const r = await runModelCatalogRefresh(h.deps, OPTS);
    expect(h.scanned.length).toBeLessThanOrEqual(4); // not 25 pages
    expect(r.examined).toBeLessThanOrEqual(8);
  });

  it('takes due rows round-robin from the cursor: early rows that come due again, or keep failing, never starve the tail', async () => {
    // More providers than one tick's budget, and every row stays due (nothing is
    // ever marked fresh — the worst case: capacity exceeded, or rows that keep failing).
    const rows = [row(1), row(2), row(3), row(4), row(5), row(6), row(7)];
    const h = harness(rows, { markFresh: () => Promise.resolve() });
    const order: string[] = [];
    for (let tick = 0; tick < 3; tick += 1) {
      const before = h.refreshed.length;
      await runModelCatalogRefresh(h.deps, { ...OPTS, concurrency: 1 });
      order.push(...h.refreshed.slice(before).map((x) => x.id));
    }
    // 3 ticks × budget 3 = 9 starts over 7 rows: every row reached, in rotation.
    expect(order).toEqual(['p001', 'p002', 'p003', 'p004', 'p005', 'p006', 'p007', 'p001', 'p002']);
  });

  it('with concurrent lanes the cursor names the furthest row that STARTED, never one only claimed', async () => {
    // Lane 1 claims p001 and sleeps long; lane 2 claims p002, starts it, then claims
    // p003 as the tick runs out. p001 was claimed but never ran — a cursor derived from
    // the START COUNT would name it (and skip it next tick); the furthest-started row,
    // p002, is the right place to resume.
    let clock = 0;
    let sleeps = 0;
    const h = harness([row(1), row(2), row(3)], {
      now: () => clock,
      sleep: async () => {
        const n = ++sleeps;
        if (n === 1) await new Promise((r) => setTimeout(r, 0)); // lane 1: slow jitter
        if (n === 3) clock += OPTS.tickBudgetMs; // lane 2's second claim: out of time
      },
    });
    const r = await runModelCatalogRefresh(h.deps, { ...OPTS, concurrency: 2 });
    expect(h.refreshed.map((x) => x.id)).toEqual(['p002']);
    expect(r.carriedOver).toBe(2);
    expect(await h.deps.readCursor()).toBe('p002');
  });

  it('refreshes each row under its OWN owner', async () => {
    const h = harness([row(1, 'alice'), row(2, 'bob')]);
    await runModelCatalogRefresh(h.deps, OPTS);
    expect(h.refreshed).toEqual([
      { principal: { kind: 'user', userId: 'alice' }, id: 'p001' },
      { principal: { kind: 'user', userId: 'bob' }, id: 'p002' },
    ]);
  });

  it('consecutive failures back off — 1h, 2h, 4h … capped at a day — and a success resets them', async () => {
    let ok = false;
    const h = harness([row(1)], {
      refresh: () => Promise.resolve({ ok }),
    });
    const ttls: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      h.fresh.clear();
      await runModelCatalogRefresh(h.deps, OPTS);
      ttls.push(h.marks.at(-1)!.ttlMs);
    }
    const H = 3_600_000;
    expect(ttls).toEqual([H, 2 * H, 4 * H, 8 * H, 16 * H, 24 * H, 24 * H]);
    ok = true;
    h.fresh.clear();
    await runModelCatalogRefresh(h.deps, OPTS);
    expect(h.marks.at(-1)!.ttlMs).toBe(OPTS.freshTtlMs);
    expect(h.failures.has('p001')).toBe(false);
    ok = false;
    h.fresh.clear();
    await runModelCatalogRefresh(h.deps, OPTS);
    expect(h.marks.at(-1)!.ttlMs).toBe(H); // back to the first spacing
  });

  it('a typed failure or a throw is contained, warned with a fixed message, and retried on the short spacing', async () => {
    const h = harness([row(1), row(2), row(3)], {
      refresh: (_p, id) =>
        id === 'p001'
          ? Promise.resolve({ ok: false })
          : id === 'p002'
            ? Promise.reject(new Error('secret-bearing detail sk-123'))
            : Promise.resolve({ ok: true }),
    });
    const r = await runModelCatalogRefresh(h.deps, OPTS);
    expect(r).toMatchObject({ refreshed: 1, failed: 2 });
    expect(h.marks).toEqual(
      expect.arrayContaining([
        { id: 'p001', ttlMs: OPTS.retryTtlMs },
        { id: 'p002', ttlMs: OPTS.retryTtlMs },
        { id: 'p003', ttlMs: OPTS.freshTtlMs },
      ]),
    );
    expect(h.warnings).toEqual([
      'model catalog refresh: a provider listing failed',
      'model catalog refresh: a provider listing failed',
    ]);
    expect(h.warnings.join()).not.toContain('sk-123');
  });

  it('a refresh past its deadline is ABORTED, counted, retried later, and never unhandled', async () => {
    jest.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const h = harness([row(1)], {
        refresh: (_p, _id, signal) => {
          signals.push(signal);
          return new Promise(() => undefined);
        },
      });
      const done = runModelCatalogRefresh(h.deps, OPTS);
      await jest.advanceTimersByTimeAsync(OPTS.perRowDeadlineMs - 1);
      expect(signals[0]!.aborted).toBe(false); // not before its deadline
      await jest.advanceTimersByTimeAsync(2);
      const r = await done;
      expect(r).toMatchObject({ timeout: 1, refreshed: 0 });
      // The listing is told to stop — it must not write after being counted failed.
      expect(signals[0]!.aborted).toBe(true);
      expect(h.marks).toEqual([{ id: 'p001', ttlMs: OPTS.retryTtlMs }]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('an unreadable freshness cache marks every row fresh — no listing stampede', async () => {
    const h = harness([row(1), row(2), row(3)], {
      freshAmong: () => Promise.reject(new Error('redis down')),
    });
    const r = await runModelCatalogRefresh(h.deps, OPTS);
    expect(r).toMatchObject({ examined: 3, due: 0, refreshed: 0 });
    expect(h.refreshed).toEqual([]);
  });

  it('stops between rows on shutdown and at the tick budget', async () => {
    let stop = false;
    const h = harness([row(1), row(2), row(3)], {
      refresh: (_p, id) => {
        stop = true; // shutdown requested while the first row runs
        return Promise.resolve({ ok: id !== '' });
      },
      shouldStop: () => stop,
    });
    const r = await runModelCatalogRefresh(h.deps, { ...OPTS, concurrency: 1 });
    expect(r.refreshed).toBe(1);
    expect(r.carriedOver).toBe(2);

    let clock = 0;
    const t = harness([row(1), row(2), row(3)], {
      now: () => clock,
      refresh: () => {
        clock += OPTS.tickBudgetMs; // the first refresh exhausts the tick
        return Promise.resolve({ ok: true });
      },
    });
    const timed = await runModelCatalogRefresh(t.deps, { ...OPTS, concurrency: 1 });
    expect(timed.refreshed).toBe(1);
  });
});
