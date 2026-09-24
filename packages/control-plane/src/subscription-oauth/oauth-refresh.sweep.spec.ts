import type { OauthSweepRow, Principal, ProviderRow } from '@polyrouter/shared/server';
import { runOauthRefreshSweep, type SweepDeps, type SweepOptions } from './oauth-refresh.sweep';
import type { ForceRefreshOutcome } from './subscription-oauth.service';

const MIN = 60_000;
const OPTS: SweepOptions = {
  nearExpiryMs: 60 * MIN,
  livenessBudget: 25,
  concurrency: 4,
  perRowDeadlineMs: 20_000,
  tickBudgetMs: 12 * 60 * MIN,
  pageSize: 50,
  jitterMaxMs: 2_000,
  retryTtlMs: 60 * MIN,
};

interface World {
  rows: OauthSweepRow[];
  verified: Set<string>;
  checked: Map<string, number>;
  order: string[];
  inFlight: number;
  maxInFlight: number;
  owners: Array<{ id: string; owner: string }>;
  outcome: (id: string) => Promise<ForceRefreshOutcome>;
  clock: number;
  stop: boolean;
}

function world(rows: OauthSweepRow[]): { w: World; deps: SweepDeps } {
  const w: World = {
    rows,
    verified: new Set(),
    checked: new Map(),
    order: [],
    inFlight: 0,
    maxInFlight: 0,
    owners: [],
    outcome: () => Promise.resolve('refreshed'),
    clock: 1_000_000,
    stop: false,
  };
  const deps: SweepDeps = {
    listPage: (afterId, limit) => {
      const sorted = [...w.rows].sort((a, b) => a.id.localeCompare(b.id));
      const start = afterId === null ? 0 : sorted.findIndex((r) => r.id > afterId);
      return Promise.resolve(start < 0 ? [] : sorted.slice(start, start + limit));
    },
    findById: (principal: Principal, id: string) => {
      w.owners.push({ id, owner: principal.kind === 'user' ? principal.userId : '?' });
      return Promise.resolve({ id, encryptedCredentials: `cipher-${id}` } as ProviderRow);
    },
    forceRefresh: async (_p, id, envelope) => {
      expect(envelope).toBe(`cipher-${id}`); // keyed on the credential re-read for THIS row
      w.order.push(id);
      w.inFlight += 1;
      w.maxInFlight = Math.max(w.maxInFlight, w.inFlight);
      await new Promise((r) => setTimeout(r, 1));
      w.inFlight -= 1;
      const o = await w.outcome(id);
      if (o === 'refreshed' || o === 'adopted') w.verified.add(id); // the service's own marker
      return o;
    },
    verifiedAmong: (ids) => Promise.resolve(new Set(ids.filter((i) => w.verified.has(i)))),
    markChecked: (id, ttl) => {
      w.checked.set(id, ttl);
      w.verified.add(id);
      return Promise.resolve();
    },
    sleep: () => Promise.resolve(),
    now: () => w.clock,
    random: () => 0.5,
    shouldStop: () => w.stop,
    warn: () => undefined,
  };
  return { w, deps };
}

function rowsOf(specs: Array<[string, number | null]>, clock = 1_000_000): OauthSweepRow[] {
  return specs.map(([id, m]) => ({
    id,
    ownerUserId: `owner-${id}`,
    credentialExpiresAt: m === null ? null : new Date(clock + m * MIN),
  }));
}

describe('runOauthRefreshSweep (add-provider-health-signals)', () => {
  it('refreshes known near-expiry rows first, soonest first, at most `concurrency` at once, each under its own owner', async () => {
    const rows = rowsOf([
      ['a', 50],
      ['b', 5],
      ['c', 30],
      ['d', 10],
      ['e', 55],
      ['f', 20],
      ['g', 600], // far from expiry, verified below → nothing to do
    ]);
    const { w, deps } = world(rows);
    w.verified.add('g');
    const r = await runOauthRefreshSweep(deps, OPTS);
    expect(r.nearExpiry).toBe(6);
    expect(w.order).toEqual(['b', 'd', 'f', 'c', 'a', 'e']);
    expect(w.maxInFlight).toBeLessThanOrEqual(4);
    expect(w.owners.every((o) => o.owner === `owner-${o.id}`)).toBe(true);
    expect(w.order).not.toContain('g');
  });

  it('many unknown-expiry rows cannot crowd out one imminent known expiry', async () => {
    const specs: Array<[string, number | null]> = Array.from({ length: 100 }, (_, i) => [
      `n${String(i).padStart(3, '0')}`,
      null,
    ]);
    specs.push(['zz-imminent', 3]);
    const { w, deps } = world(rowsOf(specs));
    await runOauthRefreshSweep(deps, OPTS);
    expect(w.order[0]).toBe('zz-imminent');
    // Unknown-expiry rows are liveness-class: budgeted.
    expect(w.order.length).toBe(1 + OPTS.livenessBudget);
  });

  it('carries work over when the tick budget runs out', async () => {
    const specs: Array<[string, number | null]> = Array.from({ length: 40 }, (_, i) => [
      `r${String(i).padStart(2, '0')}`,
      i,
    ]);
    const { w, deps } = world(rowsOf(specs));
    let calls = 0;
    deps.now = () => {
      calls += 1;
      return w.clock + (calls > 30 ? OPTS.tickBudgetMs : 0); // time runs out mid-sweep
    };
    const r = await runOauthRefreshSweep(deps, OPTS);
    expect(w.order.length).toBeGreaterThan(0);
    expect(w.order.length).toBeLessThan(40);
    expect(r.carriedOver).toBe(40 - w.order.length);
  });

  it('spreads 60 unverified grants over ticks: at most the budget per tick, each checked once', async () => {
    const specs: Array<[string, number | null]> = Array.from({ length: 60 }, (_, i) => [
      `v${String(i).padStart(2, '0')}`,
      24 * 60, // a day out: liveness-class only because unverified
    ]);
    const { w, deps } = world(rowsOf(specs));
    const perTick: number[] = [];
    for (let tick = 0; tick < 3; tick += 1) {
      const before = w.order.length;
      await runOauthRefreshSweep(deps, OPTS);
      perTick.push(w.order.length - before);
    }
    expect(perTick).toEqual([25, 25, 10]);
    expect(new Set(w.order).size).toBe(60);
  });

  it('a transient liveness failure gets the short retry key; the others still progress', async () => {
    const specs: Array<[string, number | null]> = [
      ['flaky', 24 * 60],
      ['ok-1', 24 * 60],
      ['ok-2', 24 * 60],
    ];
    const { w, deps } = world(rowsOf(specs));
    w.outcome = (id) => Promise.resolve(id === 'flaky' ? 'transient' : 'refreshed');
    await runOauthRefreshSweep(deps, OPTS);
    expect(w.checked.get('flaky')).toBe(OPTS.retryTtlMs);
    expect(w.order).toEqual(['flaky', 'ok-1', 'ok-2']);
    // Next tick: the flaky row is inside its retry window — not re-dialed.
    const before = w.order.length;
    await runOauthRefreshSweep(deps, OPTS);
    expect(w.order.length).toBe(before);
  });

  it("one row's failure is contained — the rest are still refreshed", async () => {
    const { w, deps } = world(
      rowsOf([
        ['boom', 5],
        ['fine-1', 6],
        ['fine-2', 7],
      ]),
    );
    w.outcome = (id) =>
      id === 'boom' ? Promise.reject(new Error('db down')) : Promise.resolve('refreshed');
    const r = await runOauthRefreshSweep(deps, OPTS);
    expect(r.outcomes.failed).toBe(1);
    expect(r.outcomes.refreshed).toBe(2);
  });

  it('stops promptly at shutdown', async () => {
    const specs: Array<[string, number | null]> = Array.from({ length: 30 }, (_, i) => [
      `s${String(i).padStart(2, '0')}`,
      i,
    ]);
    const { w, deps } = world(rowsOf(specs));
    w.outcome = () => {
      w.stop = true; // shutdown begins during the first refresh
      return Promise.resolve('refreshed');
    };
    await runOauthRefreshSweep(deps, OPTS);
    expect(w.order.length).toBeLessThanOrEqual(OPTS.concurrency);
  });

  it('a row that vanished or lost its credential before the re-read is skipped', async () => {
    const { w, deps } = world(rowsOf([['gone', 5]]));
    deps.findById = () => Promise.resolve(null);
    const r = await runOauthRefreshSweep(deps, OPTS);
    expect(r.outcomes.skipped).toBe(1);
    expect(w.order).toEqual([]);
  });

  it('an unreadable verification cache is not a stampede (all treated verified)', async () => {
    const specs: Array<[string, number | null]> = Array.from({ length: 40 }, (_, i) => [
      `c${String(i).padStart(2, '0')}`,
      24 * 60,
    ]);
    const { w, deps } = world(rowsOf(specs));
    deps.verifiedAmong = (ids) => Promise.resolve(new Set(ids)); // what the scheduler returns on a Redis error
    await runOauthRefreshSweep(deps, OPTS);
    expect(w.order).toEqual([]);
  });
});
