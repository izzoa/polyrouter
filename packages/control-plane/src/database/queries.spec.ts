import { agents, providers, tiers, userPrincipal } from '@polyrouter/shared/server';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import {
  buildFindById,
  buildInsertValues,
  buildList,
  buildRemove,
  buildUpdate,
  stripProtected,
  type AnyOwnedTable,
} from './queries';

// Never connects: pg pools are lazy and .toSQL() only renders the query.
const db = drizzle(new Pool({ connectionString: 'postgresql://unused:unused@localhost:9/unused' }));
const principal = userPrincipal('user-a');
const OWNED_TABLES: [string, AnyOwnedTable][] = [
  ['agent', agents as unknown as AnyOwnedTable],
  ['provider', providers as unknown as AnyOwnedTable],
  ['tier', tiers as unknown as AnyOwnedTable],
];

describe('scoped query builders (tenant-isolation)', () => {
  it.each(OWNED_TABLES)('every %s query carries the ownership predicate', (_name, table) => {
    const queries = [
      buildFindById(db, table, principal, 'row-1').toSQL(),
      buildList(db, table, principal).toSQL(),
      buildUpdate(db, table, principal, 'row-1', { name: 'x' }).toSQL(),
      buildRemove(db, table, principal, 'row-1').toSQL(),
    ];
    for (const q of queries) {
      expect(q.sql).toContain('owner_user_id');
      expect(q.params).toContain('user-a');
    }
  });

  it('org principals throw the canonical reserved-variant error', () => {
    const org = { kind: 'org', orgId: 'org-1' } as const;
    expect(() => buildList(db, OWNED_TABLES[0]![1], org)).toThrow(/add-org-workspaces/);
    expect(() => buildInsertValues(org, { name: 'x' })).toThrow(/add-org-workspaces/);
  });

  it('forged owners are overridden on insert', () => {
    const values = buildInsertValues(principal, {
      name: 'sneaky',
      ownerUserId: 'user-b',
      orgId: 'org-9',
      id: 'chosen-id',
    });
    expect(values['ownerUserId']).toBe('user-a');
    expect(values['orgId']).toBeNull();
    expect(values['id']).toBeUndefined();
    expect(values['name']).toBe('sneaky');
  });

  it('identity, ownership, and extra-immutable fields are stripped from patches', () => {
    const clean = stripProtected(
      { id: 'x', ownerUserId: 'user-b', orgId: 'org-9', providerId: 'p2', displayName: 'ok' },
      ['providerId'],
    );
    expect(clean).toEqual({ displayName: 'ok' });
  });
});
