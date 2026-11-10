// add-subscription-usage-history task 1.2: the plan-usage history's query builders, rendered
// without a database (`.toSQL()` only renders; the pool is lazy and never connects).
import { userPrincipal } from '@polyrouter/shared/server';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import {
  buildInsertPlanUsageSamples,
  buildListPlanUsageSamples,
  buildListPlanUsageScheduled,
  buildPrunePlanUsageSamples,
  createPlanUsageSampleAccessor,
  createPlanUsageSampleMaintenance,
} from './plan-usage-samples.queries';
import type { Db } from './database.internal';

const db = drizzle(new Pool({ connectionString: 'postgresql://unused:unused@localhost:9/unused' }));
const principal = userPrincipal('user-a');
const T0 = new Date('2026-11-09T10:00:00.000Z');
const T1 = new Date('2026-11-04T10:00:00.000Z');

describe('plan-usage sample queries (task 1.2)', () => {
  it('the history read is owner-scoped through the parent provider, in the same statement', () => {
    const q = buildListPlanUsageSamples(
      db,
      principal,
      'prov-1',
      new Map([['account:5h', T0]]),
      T1,
    ).toSQL();
    expect(q.sql).toMatch(/inner join "provider"/i);
    expect(q.sql).toContain('"provider"."owner_user_id"');
    expect(q.params).toContain('user-a');
    expect(q.params).toContain('prov-1');
    // Oldest first.
    expect(q.sql).toMatch(/order by "plan_usage_sample"\."observed_at" asc/i);
  });

  it('each listed window has its own lower bound, and every other window takes the fallback', () => {
    const q = buildListPlanUsageSamples(
      db,
      principal,
      'prov-1',
      new Map([
        ['account:5h', T0],
        ['account:weekly', T1],
      ]),
      T1,
    ).toSQL();
    expect(q.params).toEqual(
      expect.arrayContaining(['account:5h', 'account:weekly', T0.toISOString(), T1.toISOString()]),
    );
    expect(q.sql).toMatch(/not in/i);
    // Without a fallback, no other window is read.
    const only = buildListPlanUsageSamples(
      db,
      principal,
      'prov-1',
      new Map([['account:5h', T0]]),
    ).toSQL();
    expect(only.sql).not.toMatch(/not in/i);
  });

  it('a read that names nothing makes no query and reads nothing', async () => {
    const calls: string[] = [];
    const spy = new Proxy(db, {
      get(target, prop, receiver) {
        calls.push(String(prop));
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as unknown as Db;
    const accessor = createPlanUsageSampleAccessor(spy);
    await expect(accessor.listPlanUsageSamples(principal, 'prov-1', new Map())).resolves.toEqual(
      [],
    );
    expect(calls).toEqual([]);
  });

  it('the insert skips an already-recorded observation (ON CONFLICT DO NOTHING on the unique key)', () => {
    const q = buildInsertPlanUsageSamples(db, [
      {
        providerId: 'prov-1',
        windowKey: 'account:5h',
        usedPercent: null,
        resetAt: null,
        observedAt: T0,
      },
    ]).toSQL();
    expect(q.sql).toMatch(/on conflict \("provider_id","window_key","observed_at"\) do nothing/i);
    // An unknown percent is written as null, never 0.
    expect(q.params).toContain(null);
    expect(q.params).not.toContain(0);
  });

  it('the prune deletes a bounded batch of expired samples', () => {
    const q = buildPrunePlanUsageSamples(db, T1, 5_000).toSQL();
    expect(q.sql).toMatch(/^delete from "plan_usage_sample"/i);
    expect(q.sql).toMatch(/"observed_at" < \$\d/);
    expect(q.sql).toMatch(/limit \$\d/i);
    expect(q.params).toEqual([T1.toISOString(), 5_000]);
  });

  it('an empty insert and a non-positive prune make no query', async () => {
    const touched: string[] = [];
    const spy = new Proxy(db, {
      get(target, prop, receiver) {
        touched.push(String(prop));
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as unknown as Db;
    const m = createPlanUsageSampleMaintenance(spy);
    await expect(m.insertPlanUsageSamples([])).resolves.toBe(0);
    await expect(m.prunePlanUsageSamples(T1, 0)).resolves.toBe(0);
    expect(touched).toEqual([]);
  });

  it('the schedule listing selects non-secret columns of preset-bound, switched-on rows only', () => {
    const q = buildListPlanUsageScheduled(db, 'after-1', 200).toSQL();
    const selected = q.sql.slice(0, q.sql.toLowerCase().indexOf(' from '));
    expect(selected).not.toContain('encrypted_credentials');
    expect(q.sql).toContain('"provider"."check_plan_usage" = $');
    expect(q.sql).toContain('"provider"."credential_error" is null');
    expect(q.sql).toContain('"provider"."encrypted_credentials" is not null');
    expect(q.params).toEqual(expect.arrayContaining(['subscription', true, 'after-1', 200]));
  });
});
