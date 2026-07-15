import { and, eq } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { assertUserPrincipal, ownershipPredicate, type Principal } from '@polyrouter/shared/server';
import type { Db } from './database.internal';

/** An owned table as the guard consumes it (id + ownership columns). */
export type AnyOwnedTable = PgTable & {
  id: AnyPgColumn;
  ownerUserId: AnyPgColumn;
  orgId: AnyPgColumn;
};

const PROTECTED_COLUMNS = new Set(['id', 'ownerUserId', 'orgId']);

/** Strips identity/ownership (and any extra immutable) fields from a patch at
 * runtime — the type layer already omits them, this defends against casts. */
export function stripProtected(
  patch: Record<string, unknown>,
  extraImmutable: readonly string[] = [],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(patch).filter(
      ([key]) => !PROTECTED_COLUMNS.has(key) && !extraImmutable.includes(key),
    ),
  );
}

/** Forces ownership columns from the principal — caller-supplied owner values
 * can never survive (invariant 5: ownership is not caller-assignable). */
export function buildInsertValues(
  principal: Principal,
  values: Record<string, unknown>,
): Record<string, unknown> {
  assertUserPrincipal(principal);
  const { id: _id, ownerUserId: _owner, orgId: _org, ...rest } = values;
  return { ...rest, ownerUserId: principal.userId, orgId: null };
}

/* Query builders are separated from execution so unit tests can assert the
 * ownership predicate is present in the generated SQL of EVERY method. */

export function buildFindById(db: Db, table: AnyOwnedTable, principal: Principal, id: string) {
  return db
    .select()
    .from(table)
    .where(and(eq(table.id, id), ownershipPredicate(table, principal)))
    .limit(1);
}

export function buildList(db: Db, table: AnyOwnedTable, principal: Principal) {
  return db.select().from(table).where(ownershipPredicate(table, principal));
}

export function buildUpdate(
  db: Db,
  table: AnyOwnedTable,
  principal: Principal,
  id: string,
  cleanPatch: Record<string, unknown>,
) {
  return db
    .update(table)
    .set(cleanPatch)
    .where(and(eq(table.id, id), ownershipPredicate(table, principal)))
    .returning();
}

export function buildRemove(db: Db, table: AnyOwnedTable, principal: Principal, id: string) {
  return db
    .delete(table)
    .where(and(eq(table.id, id), ownershipPredicate(table, principal)))
    .returning({ id: table.id });
}
