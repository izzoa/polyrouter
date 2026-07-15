import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  agents,
  models,
  ownershipPredicate,
  providers,
  routingEntries,
  routingRules,
  tiers,
  users,
  type ModelAccessor,
  type ModelInsertInput,
  type ModelPatch,
  type OwnedRepository,
  type PersistenceFacilities,
  type PersistencePort,
  type Principal,
  type RoutingEntryAccessor,
  type TierRow,
} from '@polyrouter/shared/server';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Db } from './database.internal';
import {
  buildFindById,
  buildInsertValues,
  buildList,
  buildRemove,
  buildUpdate,
  stripProtected,
  type AnyOwnedTable,
} from './queries';

function createOwnedRepository<TRow, TInsertInput, TPatch>(
  db: Db,
  table: AnyOwnedTable,
): OwnedRepository<TRow, TInsertInput, TPatch> {
  return {
    async findById(principal, id) {
      const rows = await buildFindById(db, table, principal, id);
      return (rows[0] as TRow | undefined) ?? null;
    },
    async list(principal) {
      const rows = await buildList(db, table, principal);
      return rows as TRow[];
    },
    async insert(principal, values) {
      const rows = await db
        .insert(table)
        .values(buildInsertValues(principal, values as Record<string, unknown>))
        .returning();
      const row = rows[0] as TRow | undefined;
      if (!row) throw new Error('insert returned no row');
      return row;
    },
    async update(principal, id, patch) {
      const clean = stripProtected(patch as Record<string, unknown>);
      if (Object.keys(clean).length === 0) {
        return this.findById(principal, id);
      }
      const rows = await buildUpdate(db, table, principal, id, clean);
      return (rows[0] as TRow | undefined) ?? null;
    },
    async remove(principal, id) {
      const rows = await buildRemove(db, table, principal, id);
      return rows.length > 0;
    },
  };
}

/** Subquery of the principal's provider ids — the ownership fence every
 * model accessor applies (models are owned through their provider). */
function ownedProviderIds(db: Db, principal: Principal) {
  return db
    .select({ id: providers.id })
    .from(providers)
    .where(ownershipPredicate(providers, principal));
}

function createModelAccessor(db: Db): ModelAccessor {
  return {
    async listForPrincipal(principal) {
      return db
        .select()
        .from(models)
        .where(inArray(models.providerId, ownedProviderIds(db, principal)));
    },
    async findById(principal, id) {
      const rows = await db
        .select()
        .from(models)
        .where(and(eq(models.id, id), inArray(models.providerId, ownedProviderIds(db, principal))))
        .limit(1);
      return rows[0] ?? null;
    },
    async createForProvider(principal, providerId, values: ModelInsertInput) {
      // Transactional parent-ownership check; a racing parent delete fails
      // closed on the FK. providerId comes only from the validated argument.
      return db.transaction(async (tx) => {
        const parent = await tx
          .select({ id: providers.id })
          .from(providers)
          .where(and(eq(providers.id, providerId), ownershipPredicate(providers, principal)))
          .limit(1);
        if (parent.length === 0) return null;
        const { id: _id, providerId: _p, ...rest } = values as Record<string, unknown>;
        const rows = await tx
          .insert(models)
          .values({ ...(rest as ModelInsertInput), providerId })
          .returning();
        return rows[0] ?? null;
      });
    },
    async update(principal, id, patch: ModelPatch) {
      const clean = stripProtected(patch as Record<string, unknown>, ['providerId']);
      if (Object.keys(clean).length === 0) return this.findById(principal, id);
      const rows = await db
        .update(models)
        .set(clean)
        .where(and(eq(models.id, id), inArray(models.providerId, ownedProviderIds(db, principal))))
        .returning();
      return rows[0] ?? null;
    },
    async remove(principal, id) {
      const rows = await db
        .delete(models)
        .where(and(eq(models.id, id), inArray(models.providerId, ownedProviderIds(db, principal))))
        .returning({ id: models.id });
      return rows.length > 0;
    },
  };
}

/** Subquery of the principal's tier ids (routing entries are owned through
 * their tier; the linked model must also be reachable by the principal). */
function ownedTierIds(db: Db, principal: Principal) {
  return db.select({ id: tiers.id }).from(tiers).where(ownershipPredicate(tiers, principal));
}

function ownedModelIds(db: Db, principal: Principal) {
  return db
    .select({ id: models.id })
    .from(models)
    .where(inArray(models.providerId, ownedProviderIds(db, principal)));
}

function createRoutingEntryAccessor(db: Db): RoutingEntryAccessor {
  return {
    async listForTier(principal, tierId) {
      return db
        .select()
        .from(routingEntries)
        .where(
          and(
            eq(routingEntries.tierId, tierId),
            inArray(routingEntries.tierId, ownedTierIds(db, principal)),
          ),
        );
    },
    async add(principal, entry) {
      return db.transaction(async (tx) => {
        const tier = await tx
          .select({ id: tiers.id })
          .from(tiers)
          .where(and(eq(tiers.id, entry.tierId), ownershipPredicate(tiers, principal)))
          .limit(1);
        if (tier.length === 0) return null;
        const model = await tx
          .select({ id: models.id })
          .from(models)
          .where(
            and(
              eq(models.id, entry.modelId),
              inArray(models.providerId, ownedProviderIds(tx, principal)),
            ),
          )
          .limit(1);
        if (model.length === 0) return null;
        const rows = await tx
          .insert(routingEntries)
          .values({ tierId: entry.tierId, modelId: entry.modelId, position: entry.position })
          .returning();
        return rows[0] ?? null;
      });
    },
    async setPosition(principal, id, position) {
      const rows = await db
        .update(routingEntries)
        .set({ position })
        .where(
          and(
            eq(routingEntries.id, id),
            inArray(routingEntries.tierId, ownedTierIds(db, principal)),
          ),
        )
        .returning();
      return rows[0] ?? null;
    },
    async remove(principal, id) {
      const rows = await db
        .delete(routingEntries)
        .where(
          and(
            eq(routingEntries.id, id),
            inArray(routingEntries.tierId, ownedTierIds(db, principal)),
          ),
        )
        .returning({ id: routingEntries.id });
      return rows.length > 0;
    },
  };
}

export function buildPersistencePort(db: Db): PersistencePort {
  return {
    agents: createOwnedRepository(db, agents as unknown as AnyOwnedTable),
    providers: createOwnedRepository(db, providers as unknown as AnyOwnedTable),
    tiers: createOwnedRepository(db, tiers as unknown as AnyOwnedTable),
    routingRules: createOwnedRepository(db, routingRules as unknown as AnyOwnedTable),
    models: createModelAccessor(db),
    routingEntries: createRoutingEntryAccessor(db),
    users: {
      async count() {
        const rows = await db.select({ value: sql<number>`count(*)::int` }).from(users);
        return rows[0]?.value ?? 0;
      },
    },
    async ensureDefaultTier(principal): Promise<TierRow> {
      // Idempotent + race-safe: the UNIQUE (owner_user_id, key) constraint
      // absorbs concurrent calls; onConflictDoNothing keeps them silent.
      await db
        .insert(tiers)
        .values(
          buildInsertValues(principal, {
            key: 'default',
            displayName: 'Default',
            description: 'Serves everything unless told otherwise',
          }) as typeof tiers.$inferInsert,
        )
        .onConflictDoNothing({ target: [tiers.ownerUserId, tiers.key] });
      const rows = await db
        .select()
        .from(tiers)
        .where(and(eq(tiers.key, 'default'), ownershipPredicate(tiers, principal)))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error('ensureDefaultTier: default tier missing after upsert');
      return row;
    },
  };
}

export function buildPersistenceFacilities(db: NodePgDatabase): PersistenceFacilities {
  return {
    async withTransaction(fn) {
      // The callback receives a TRANSACTION-BOUND scoped port — never raw
      // drizzle — so even privileged code cannot issue unscoped SQL.
      return db.transaction(async (tx) => fn(buildPersistencePort(tx)));
    },
    async withAdvisoryLock(lockKey, fn) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`);
        return fn(buildPersistencePort(tx));
      });
    },
  };
}
