import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { userPrincipal } from '@polyrouter/shared/server';
import { createAnalyticsAccessor } from './analytics.queries';

/**
 * The summary's request-mix classifiers (zero-cost-unbilled-errors D6b). Behaviour is
 * asserted against a real database in `test/analytics/analytics.e2e-spec.ts`; this pins
 * the SHAPE of the SQL with no database, so reverting a predicate fails fast.
 */

/** Drizzle qualifies a column inside a nested `sql` fragment, so compare bare. */
const bare = (sql: string): string => sql.replace(/"request_(log|attempt)"\./g, '');

async function summarySql(): Promise<{ log: string; attempt: string; result: object }> {
  const captured: string[] = [];
  const client = {
    query: (q: string | { text: string }): Promise<{ rows: unknown[]; fields: unknown[] }> => {
      captured.push(typeof q === 'string' ? q : q.text);
      return Promise.resolve({ rows: [], fields: [] });
    },
  };
  const db = drizzle(client as unknown as Pool);
  const result = await createAnalyticsAccessor(db).summary(userPrincipal('owner-1'), {
    from: new Date('2025-03-01T00:00:00.000Z'),
    to: new Date('2025-04-01T00:00:00.000Z'),
  });
  // The log aggregate, then the attempt aggregate.
  expect(captured).toHaveLength(2);
  return { log: bare(captured[0]!), attempt: bare(captured[1]!), result };
}

describe('analytics summary request mix SQL (zero-cost-unbilled-errors)', () => {
  it('a not-billed row is not free, and a legacy NULL row still is', async () => {
    const { log } = await summarySql();
    // `IS DISTINCT FROM`, not `<>`: a NULL marker (legacy) must still count as free.
    expect(log).toContain(
      'cast(count(*) filter (where "cost" = 0 and "billed" is distinct from false) as int)',
    );
  });

  it('counts the not-billed requests apart', async () => {
    const { log } = await summarySql();
    expect(log).toContain('cast(count(*) filter (where "billed" = false) as int)');
  });

  it('leaves the other classifiers and the attempt ledger untouched', async () => {
    const { log, attempt } = await summarySql();
    // paid / unpriced / subscription / cash keep classifying on cost + provider kind only.
    expect(log).toContain('cast(count(*) filter (where "cost" > 0) as int)');
    expect(log).toContain('cast(count(*) filter (where "cost" is null) as int)');
    expect(log).toContain(
      `cast(count(*) filter (where "cost" > 0 and "provider_kind" = 'subscription') as int)`,
    );
    // Exactly two predicates read the marker; no other aggregate (spend, tokens,
    // errorCount) may start ignoring it, and request_attempt has no such column.
    expect(log.match(/"billed"/g)).toHaveLength(2);
    expect(attempt).not.toMatch(/billed/);
  });

  it('reports a zero for both counters when the range holds no rows', async () => {
    const { result } = await summarySql();
    expect(result).toMatchObject({ requests: 0, freeRequests: 0, notBilledRequests: 0 });
  });
});
