import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  agents,
  FIRST_ADMIN_LOCK,
  tiers,
  users,
  type AgentAuthRecord,
  type IdentityPort,
} from '@polyrouter/shared/server';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Db } from './database.internal';

const DEFAULT_TIER = {
  key: 'default',
  displayName: 'Default',
  description: 'Serves everything unless told otherwise',
} as const;

async function provisionTierFor(db: Db, userId: string): Promise<void> {
  await db
    .insert(tiers)
    .values({ ...DEFAULT_TIER, ownerUserId: userId, orgId: null })
    .onConflictDoNothing({ target: [tiers.ownerUserId, tiers.key] });
}

/** Identity-plane port built inside the database module over the private
 * drizzle handle. Advisory-locked promotion/reconciliation converge under
 * concurrency; agentAuth is the guard's O(1) key-resolution accessor. */
export function buildIdentityPort(root: NodePgDatabase): IdentityPort {
  return {
    async ensureFirstAdmin(): Promise<string | null> {
      return root.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${FIRST_ADMIN_LOCK})`);
        const admins = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.role, 'admin'))
          .limit(1);
        if (admins[0]) return admins[0].id;
        const earliest = await tx
          .select({ id: users.id })
          .from(users)
          .orderBy(users.createdAt)
          .limit(1);
        const first = earliest[0];
        if (!first) return null;
        await tx.update(users).set({ role: 'admin' }).where(eq(users.id, first.id));
        return first.id;
      });
    },

    async findAdminUserId(): Promise<string | null> {
      const rows = await root
        .select({ id: users.id })
        .from(users)
        .where(eq(users.role, 'admin'))
        .limit(1);
      return rows[0]?.id ?? null;
    },

    async isAdmin(userId: string): Promise<boolean> {
      const rows = await root
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, userId), eq(users.role, 'admin')))
        .limit(1);
      return rows.length > 0;
    },

    async provisionDefaultTier(userId: string): Promise<void> {
      await provisionTierFor(root, userId);
    },

    async provisionMissingDefaultTiers(): Promise<number> {
      // Advisory-locked so concurrent boots don't double-provision; a single
      // INSERT…SELECT of every user lacking a `default` tier, conflict-safe.
      return root.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${FIRST_ADMIN_LOCK})`);
        const missing = await tx
          .select({ id: users.id })
          .from(users)
          .leftJoin(tiers, and(eq(tiers.ownerUserId, users.id), eq(tiers.key, 'default')))
          .where(isNull(tiers.id));
        for (const row of missing) {
          await provisionTierFor(tx, row.id);
        }
        return missing.length;
      });
    },

    agentAuth: {
      async findByPrefix(prefix: string): Promise<AgentAuthRecord | null> {
        const rows = await root
          .select({
            id: agents.id,
            ownerUserId: agents.ownerUserId,
            apiKeyHash: agents.apiKeyHash,
            apiKeyPrefix: agents.apiKeyPrefix,
          })
          .from(agents)
          .where(eq(agents.apiKeyPrefix, prefix))
          .limit(1);
        return rows[0] ?? null;
      },
      async touchLastUsed(agentId: string): Promise<void> {
        await root.update(agents).set({ lastUsedAt: new Date() }).where(eq(agents.id, agentId));
      },
    },
  };
}
