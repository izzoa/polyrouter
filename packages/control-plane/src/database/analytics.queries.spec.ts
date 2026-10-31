import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { userPrincipal, type AutoPerformanceData } from '@polyrouter/shared/server';
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

/**
 * The auto aggregation's disjoint per-stage exits (redesign-auto-routing-pipeline D6).
 * Behaviour is asserted against a real database in `test/analytics/analytics.e2e-spec.ts`;
 * this pins where the five counts live and what they filter on, with no database.
 */

const COUNT = 'cast(count(*)';

/** Every query `autoPerformance` issues, bare, plus its result. The first query — the
 * banded totals `t` — gets one row whose i-th column holds i, so the `t!` dereference
 * succeeds AND each figure traces back to the column it read. Every later query reads
 * empty, which the rest of the aggregation already tolerates. */
async function autoSql(): Promise<{ queries: string[]; result: AutoPerformanceData }> {
  const captured: string[] = [];
  const client = {
    query: (q: string | { text: string }): Promise<{ rows: unknown[]; fields: unknown[] }> => {
      const text = typeof q === 'string' ? q : q.text;
      captured.push(text);
      // Every column of `t` is an `intCount`, so its count occurrences ARE its columns.
      const columns = text.split(COUNT).length - 1;
      const rows = captured.length === 1 ? [Array.from({ length: columns }, (_, i) => i + 1)] : [];
      return Promise.resolve({ rows, fields: [] });
    },
  };
  const db = drizzle(client as unknown as Pool);
  const result = await createAnalyticsAccessor(db).autoPerformance(
    userPrincipal('owner-1'),
    { from: new Date('2025-03-01T00:00:00.000Z'), to: new Date('2025-04-01T00:00:00.000Z') },
    'day',
    null,
  );
  return { queries: captured.map(bare), result };
}

/** The 1-based select-list position of the one count filtered EXACTLY on `filter`. */
function column(query: string, filter: string): number {
  const hits = query
    .split(COUNT)
    .flatMap((segment, i) => (segment.startsWith(` filter (where ${filter}) as int)`) ? [i] : []));
  expect(hits).toHaveLength(1);
  return hits[0]!;
}

const EXIT_FILTERS = {
  workload: `"decision_layer" = 'workload'`,
  structural: `"decision_layer" = 'structural'`,
  semantic: `"decision_layer" = 'semantic'`,
  cascade: `"decision_layer" = 'cascade'`,
  default: `"decision_layer" not in ('workload','structural','semantic','cascade')`,
} as const;

describe('auto aggregation exits SQL (redesign-auto-routing-pipeline)', () => {
  it('counts every stage in the banded totals query, under its banded WHERE', async () => {
    const { queries } = await autoSql();
    const t = queries[0]!;
    const [select, where] = t.split(' from ');
    // Exactly `decision_layer` and nothing else — no band qualifier, so a malformed
    // `semantic` row with an ambiguous L2 band still counts once (`semantic.routed`'s
    // band-qualified predicate stays its own column, as does `cascade.requests`' base).
    for (const filter of Object.values(EXIT_FILTERS)) {
      expect(select).toContain(`${COUNT} filter (where ${filter}) as int)`);
    }
    // The same population as `evaluated`: owner + range + a structural band.
    expect(where).toContain('"structural_band" is not null');
  });

  it('makes default the complement of the four named stages, never an equality', async () => {
    const { queries } = await autoSql();
    expect(queries[0]).toContain(`${COUNT} filter (where ${EXIT_FILTERS.default}) as int)`);
    // An equality would let a banded `explicit`/`header` row fall out of every exit.
    expect(queries[0]).not.toContain(
      `${COUNT} filter (where "decision_layer" = 'default') as int)`,
    );
  });

  it('adds no round trip: no later query reads an exit', async () => {
    const { queries } = await autoSql();
    // `workload` is exempt: the same equality is the workload mix's per-class `routed`
    // count, a query that predates the exits.
    const { workload: _workload, ...others } = EXIT_FILTERS;
    for (const q of queries.slice(1)) {
      for (const filter of Object.values(others)) {
        expect(q).not.toContain(`filter (where ${filter}) as int)`);
      }
    }
  });

  it('reads each exit from its own column', async () => {
    const { queries, result } = await autoSql();
    expect(result.exits).toEqual({
      workload: column(queries[0]!, EXIT_FILTERS.workload),
      structural: column(queries[0]!, EXIT_FILTERS.structural),
      semantic: column(queries[0]!, EXIT_FILTERS.semantic),
      cascade: column(queries[0]!, EXIT_FILTERS.cascade),
      default: column(queries[0]!, EXIT_FILTERS.default),
    });
    // Five distinct columns — no exit aliases another figure's read.
    expect(new Set(Object.values(result.exits)).size).toBe(5);
  });
});
