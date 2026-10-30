import type { Pool } from 'pg';
import { createBudgetProgressAccessor } from './budget-progress.queries';
import { userPrincipal } from '@polyrouter/shared/server';

/**
 * The provenance flags of budget progress (zero-cost-unbilled-errors D5). The behaviour
 * is asserted against a real database in `test/budgets/budget-progress.e2e-spec.ts`;
 * this pins the SHAPE of the SQL with no database, so reverting the predicate or
 * widening it onto the wrong ledger fails fast.
 */

const AS_OF = new Date('2026-10-28T12:00:00.000Z');

/** A `budget` row in table-column order (drizzle reads it with `rowMode: 'array'`). */
const budgetRow = (scope: 'agent' | 'global', basis: 'cash' | 'notional'): unknown[] => [
  'b-1', // id
  'owner-1', // owner_user_id
  null, // org_id
  'test', // name
  scope,
  scope === 'agent' ? 'agent-1' : null, // agent_id
  'day',
  'block',
  basis,
  25, // amount
  '', // notify_channel_ids
  true, // enabled
  '2026-10-01T00:00:00.000Z', // created_at
];

/** Drizzle qualifies a column inside a nested `sql` fragment but not a top-level one
 * (and always qualifies on a join), so compare with the table qualifiers stripped. */
const bare = (sql: string): string => sql.replace(/"request_(log|attempt)"\./g, '');

/** Runs one progress read through a fake pool; returns the two ledger aggregates. */
async function aggregatesFor(
  scope: 'agent' | 'global',
  basis: 'cash' | 'notional',
): Promise<{ log: string; attempt: string }> {
  const aggregates: string[] = [];
  const client = {
    query: (q: string | { text: string }): Promise<{ rows: unknown[] }> => {
      const text = typeof q === 'string' ? q : q.text;
      if (text.startsWith('SELECT transaction_timestamp()'))
        return Promise.resolve({ rows: [{ as_of: AS_OF }] });
      if (text.includes('from "budget"'))
        return Promise.resolve({ rows: [budgetRow(scope, basis)] });
      if (text.includes('group by 1')) aggregates.push(text);
      return Promise.resolve({ rows: [] });
    },
    release: (): void => undefined,
  };
  const pool = { connect: () => Promise.resolve(client) } as unknown as Pick<Pool, 'connect'>;
  const res = await createBudgetProgressAccessor(pool).read(userPrincipal('owner-1'), ['b-1']);
  expect(res.results[0]!.availability).toBe('available');
  // One grouped scan per ledger, request_log first (see aggregateProgress).
  expect(aggregates).toHaveLength(2);
  return { log: bare(aggregates[0]!), attempt: bare(aggregates[1]!) };
}

const NOT_BILLED = /"billed" is distinct from false/g;

describe('budget progress provenance SQL (zero-cost-unbilled-errors)', () => {
  it.each([
    ['agent', 'cash'],
    ['agent', 'notional'],
    ['global', 'cash'],
    ['global', 'notional'],
  ] as const)(
    'excludes billed=false rows from both provenance flags on the log ledger (%s, %s)',
    async (scope, basis) => {
      const { log } = await aggregatesFor(scope, basis);
      expect(log).toContain(
        `bool_or("usage_estimated") filter (where "billed" is distinct from false)`,
      );
      expect(log).toContain(
        `bool_or("price_source" in ('native_family', 'listed')) filter (where "billed" is distinct from false)`,
      );
      // Exactly those two: nothing else in the aggregate may start ignoring the marker.
      expect(log.match(NOT_BILLED)).toHaveLength(2);
      // Not-billed rows stay metered activity: the row count is unfiltered, and so is
      // the cost sum (a not-billed row contributes a recorded 0, never a skipped row).
      expect(log).toMatch(/count\(\*\)::int,/);
      expect(log).toContain('coalesce(sum(round(coalesce("cost", 0) * 1000000)), 0)');
    },
  );

  it.each([
    ['agent', 'cash'],
    ['global', 'notional'],
  ] as const)(
    'leaves the attempt ledger alone: request_attempt has no marker (%s, %s)',
    async (scope, basis) => {
      const { attempt } = await aggregatesFor(scope, basis);
      // A superseded cascade attempt always ran, so its provenance always counts.
      expect(attempt).not.toMatch(/billed/);
      expect(attempt).toContain('bool_or("usage_estimated")');
      expect(attempt).toContain(`bool_or("price_source" in ('native_family', 'listed'))`);
    },
  );
});
