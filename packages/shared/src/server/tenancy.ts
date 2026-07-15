import { eq, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/** The authenticated owner every guarded query is scoped to (spec §11.1).
 * A union so downstream signatures never change: `user` is implemented now;
 * `org` is reserved and fails loudly until the deferred org change. */
export type Principal = { kind: 'user'; userId: string } | { kind: 'org'; orgId: string };

export function userPrincipal(userId: string): Principal {
  return { kind: 'user', userId };
}

/** The column shape a directly-owned table must expose to the guard. */
export interface OwnedTableColumns {
  id: AnyPgColumn;
  ownerUserId: AnyPgColumn;
  orgId: AnyPgColumn;
}

/** Narrows to a user principal or throws the canonical reserved-variant
 * error — the ONLY place org unsupportedness is worded. */
export function assertUserPrincipal(
  principal: Principal,
): asserts principal is { kind: 'user'; userId: string } {
  if (principal.kind !== 'user') {
    throw new Error(
      'Org principals are not supported yet — org scoping lands with the deferred add-org-workspaces change',
    );
  }
}

/** THE single site deriving the ownership predicate (CLAUDE.md invariant 5).
 * Every scoped repository and join-scoped accessor funnels through here. */
export function ownershipPredicate(table: { ownerUserId: AnyPgColumn }, principal: Principal): SQL {
  assertUserPrincipal(principal);
  return eq(table.ownerUserId, principal.userId);
}
