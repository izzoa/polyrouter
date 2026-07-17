import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import {
  agents,
  assertUserPrincipal,
  budgets,
  models,
  modelPrices,
  notificationChannels,
  ownershipPredicate,
  providers,
  requestAttempts,
  requestLogs,
  routingEntries,
  routingRules,
  routingSettings,
  tiers,
  users,
  type ModelAccessor,
  type ModelInsertInput,
  type ModelPatch,
  type ModelPriceInput,
  type OwnedRepository,
  type PersistenceFacilities,
  type PersistencePort,
  type PricingCatalog,
  type Principal,
  type RequestAttemptAccessor,
  type RequestLogAccessor,
  type RoutingEntryAccessor,
  type RoutingSettingsAccessor,
  type TierRow,
} from '@polyrouter/shared/server';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createAnalyticsAccessor } from './analytics.queries';
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
    async upsertForProvider(principal, providerId, values: ModelInsertInput) {
      // Same transactional parent-ownership fence as createForProvider, but a
      // single ON CONFLICT statement — concurrent syncs / duplicate ids converge
      // instead of racing to a unique violation. Only display_name/last_synced_at
      // are updated (never prices/capabilities — those are #8's).
      return db.transaction(async (tx) => {
        const parent = await tx
          .select({ id: providers.id })
          .from(providers)
          .where(and(eq(providers.id, providerId), ownershipPredicate(providers, principal)))
          .limit(1);
        if (parent.length === 0) return null;
        const { id: _id, providerId: _p, ...rest } = values as Record<string, unknown>;
        const insertValues = { ...(rest as ModelInsertInput), providerId };
        const set: Record<string, unknown> = {};
        if ('displayName' in rest) set['displayName'] = rest['displayName'];
        if ('lastSyncedAt' in rest) set['lastSyncedAt'] = rest['lastSyncedAt'];
        const rows = await tx
          .insert(models)
          .values(insertValues)
          .onConflictDoUpdate({
            target: [models.providerId, models.externalModelId],
            set:
              Object.keys(set).length > 0 ? set : { externalModelId: insertValues.externalModelId },
          })
          .returning();
        return rows[0] ?? null;
      });
    },
    async update(principal, id, patch: ModelPatch) {
      const clean = stripProtected(patch, ['providerId']);
      if (Object.keys(clean).length === 0) return this.findById(principal, id);
      const rows = await db
        .update(models)
        .set(clean)
        .where(and(eq(models.id, id), inArray(models.providerId, ownedProviderIds(db, principal))))
        .returning();
      return rows[0] ?? null;
    },
    async remove(principal, id) {
      return db.transaction(async (tx) => {
        await lockOwnerTiers(tx, principal); // tier-first lock order (no deadlock w/ replaceForTier)
        const rows = await tx
          .delete(models)
          .where(and(eq(models.id, id), inArray(models.providerId, ownedProviderIds(tx, principal))))
          .returning({ id: models.id });
        if (rows.length === 0) return false;
        await compactTiers(tx, principal); // E10.2: keep tier positions contiguous after the cascade
        return true;
      });
    },
    async clearPricingForProvider(principal, providerId) {
      const rows = await db
        .update(models)
        .set({ inputPricePer1m: null, outputPricePer1m: null, isFree: false })
        .where(
          and(
            eq(models.providerId, providerId),
            inArray(models.providerId, ownedProviderIds(db, principal)),
          ),
        )
        .returning({ id: models.id });
      return rows.length;
    },
  };
}

/** Subquery of the principal's tier ids (routing entries are owned through
 * their tier; the linked model must also be reachable by the principal). */
function ownedTierIds(db: Db, principal: Principal) {
  return db.select({ id: tiers.id }).from(tiers).where(ownershipPredicate(tiers, principal));
}

/** Renumber every OWNER tier's routing entries to contiguous positions 0..N-1
 * (E10.2). Run after a provider/model delete whose `ON DELETE CASCADE` removed
 * entries, so a tier that lost its position-0 (or an interior) entry stays
 * routable (`resolveTier` requires position 0 exactly). Renumbers ASCENDING so
 * each new (lower) target position is already vacated — never transiently
 * colliding with the `(tier_id, position)` unique index (the `0..4` CHECK forbids
 * a bump-to-high-offset). Compacts the WHOLE owner tier set on the post-delete
 * committed state (idempotent for already-contiguous tiers), so a concurrent
 * chain mutation can't leave an uncaptured gap. Owner-scoped (invariant 5). */
/** Lock the owner's tier rows (id order) at the START of a delete transaction, so
 * its later position compaction acquires tier locks BEFORE the cascade touches
 * routing entries — the same tier-first order `replaceForTier` uses — preventing a
 * row-lock deadlock (`40P01`) between a concurrent chain edit and a delete (E10.2,
 * clink round 2). Owner-scoped; id order also serializes concurrent deletes safely. */
async function lockOwnerTiers(db: Db, principal: Principal): Promise<void> {
  await db
    .select({ id: tiers.id })
    .from(tiers)
    .where(ownershipPredicate(tiers, principal))
    .orderBy(tiers.id)
    .for('update');
}

async function compactTiers(db: Db, principal: Principal): Promise<void> {
  const ownerTiers = await db
    .select({ id: tiers.id })
    .from(tiers)
    .where(ownershipPredicate(tiers, principal));
  for (const { id: tierId } of ownerTiers) {
    const entries = await db
      .select({ id: routingEntries.id, position: routingEntries.position })
      .from(routingEntries)
      .where(eq(routingEntries.tierId, tierId))
      .orderBy(routingEntries.position);
    for (let i = 0; i < entries.length; i += 1) {
      if (entries[i]!.position !== i) {
        await db.update(routingEntries).set({ position: i }).where(eq(routingEntries.id, entries[i]!.id));
      }
    }
  }
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
    async replaceForTier(principal, tierId, orderedModelIds) {
      return db.transaction(async (tx) => {
        // Lock the owned tier row so concurrent replacements serialize instead
        // of racing the non-deferrable UNIQUE(tier_id, position).
        const tier = await tx
          .select({ id: tiers.id })
          .from(tiers)
          .where(and(eq(tiers.id, tierId), ownershipPredicate(tiers, principal)))
          .limit(1)
          .for('update');
        if (tier.length === 0) return { status: 'tier_not_found' as const };

        // Every distinct id must be an owned model (owned through its provider).
        const uniqueIds = [...new Set(orderedModelIds)];
        if (uniqueIds.length > 0) {
          const owned = await tx
            .select({ id: models.id })
            .from(models)
            .where(
              and(
                inArray(models.id, uniqueIds),
                inArray(models.providerId, ownedProviderIds(tx, principal)),
              ),
            );
          const ownedIds = new Set(owned.map((r) => r.id));
          const unknown = uniqueIds.filter((id) => !ownedIds.has(id));
          if (unknown.length > 0) return { status: 'unknown_models' as const, modelIds: unknown };
        }

        // All-or-nothing replace: clear the chain, reinsert at positions 0..N-1.
        await tx.delete(routingEntries).where(eq(routingEntries.tierId, tierId));
        const entries =
          orderedModelIds.length > 0
            ? await tx
                .insert(routingEntries)
                .values(orderedModelIds.map((modelId, position) => ({ tierId, modelId, position })))
                .returning()
            : [];
        return { status: 'ok' as const, entries };
      });
    },
  };
}

/** Global (non-tenant) pricing catalog — append-only reads/insert; the locked
 * write orchestration lives in #8's PricingService. */
function createPricingCatalog(db: Db): PricingCatalog {
  return {
    async priceAt(modelKey, at) {
      const rows = await db
        .select()
        .from(modelPrices)
        .where(and(eq(modelPrices.modelKey, modelKey), lte(modelPrices.validFrom, at)))
        .orderBy(desc(modelPrices.validFrom))
        .limit(1);
      return rows[0] ?? null;
    },
    async latest(modelKey) {
      const rows = await db
        .select()
        .from(modelPrices)
        .where(eq(modelPrices.modelKey, modelKey))
        .orderBy(desc(modelPrices.validFrom))
        .limit(1);
      return rows[0] ?? null;
    },
    async listLatest(now) {
      return db
        .selectDistinctOn([modelPrices.modelKey])
        .from(modelPrices)
        .where(lte(modelPrices.validFrom, now))
        .orderBy(modelPrices.modelKey, desc(modelPrices.validFrom));
    },
    async insertVersion(entry: ModelPriceInput) {
      const rows = await db
        .insert(modelPrices)
        .values({
          modelKey: entry.modelKey,
          inputPricePer1m: entry.inputPricePer1m,
          outputPricePer1m: entry.outputPricePer1m,
          cacheReadPricePer1m: entry.cacheReadPricePer1m ?? null,
          cacheWritePricePer1m: entry.cacheWritePricePer1m ?? null,
          contextWindow: entry.contextWindow ?? null,
          supportsTools: entry.supportsTools ?? false,
          supportsVision: entry.supportsVision ?? false,
          supportsReasoning: entry.supportsReasoning ?? false,
          isFree: entry.isFree ?? false,
          source: entry.source,
          validFrom: entry.validFrom,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('insertVersion returned no row');
      return row;
    },
  };
}

/** Request-log audit records (#11). Batched idempotent inserts (owner forced
 * from the principal); ownership-scoped reads. */
function createRequestLogAccessor(db: Db): RequestLogAccessor {
  return {
    async insertMany(principal, rows) {
      if (rows.length === 0) return;
      assertUserPrincipal(principal);
      const owned = rows.map((r) => ({ ...r, ownerUserId: principal.userId, orgId: null }));
      await db.insert(requestLogs).values(owned).onConflictDoNothing({ target: requestLogs.id });
    },
    async list(principal) {
      return db
        .select()
        .from(requestLogs)
        .where(ownershipPredicate(requestLogs, principal))
        .orderBy(desc(requestLogs.createdAt));
    },
    async findById(principal, id) {
      const rows = await db
        .select()
        .from(requestLogs)
        .where(and(eq(requestLogs.id, id), ownershipPredicate(requestLogs, principal)))
        .limit(1);
      return rows[0] ?? null;
    },
  };
}

function createRequestAttemptAccessor(db: Db): RequestAttemptAccessor {
  return {
    async insertMany(principal, rows) {
      if (rows.length === 0) return;
      assertUserPrincipal(principal);
      const owned = rows.map((r) => ({ ...r, ownerUserId: principal.userId, orgId: null }));
      await db
        .insert(requestAttempts)
        .values(owned)
        .onConflictDoNothing({ target: requestAttempts.id });
    },
    async listForRequest(principal, requestLogId) {
      return db
        .select()
        .from(requestAttempts)
        .where(
          and(
            eq(requestAttempts.requestLogId, requestLogId),
            ownershipPredicate(requestAttempts, principal),
          ),
        )
        .orderBy(requestAttempts.attemptIndex);
    },
  };
}

/** Per-tenant auto-layer preference (#20). Owner-scoped read + one-row-per-owner
 * upsert (owner forced from the principal; conflict on the unique owner index). */
function createRoutingSettingsAccessor(db: Db): RoutingSettingsAccessor {
  return {
    async get(principal) {
      const rows = await db
        .select({
          structuralEnabled: routingSettings.structuralEnabled,
          cascadeEnabled: routingSettings.cascadeEnabled,
        })
        .from(routingSettings)
        .where(ownershipPredicate(routingSettings, principal))
        .limit(1);
      return rows[0] ?? null;
    },
    async upsert(principal, value) {
      const rows = await db
        .insert(routingSettings)
        .values(
          buildInsertValues(principal, {
            structuralEnabled: value.structuralEnabled,
            cascadeEnabled: value.cascadeEnabled,
          }) as typeof routingSettings.$inferInsert,
        )
        .onConflictDoUpdate({
          target: routingSettings.ownerUserId,
          set: {
            structuralEnabled: value.structuralEnabled,
            cascadeEnabled: value.cascadeEnabled,
            updatedAt: new Date(),
          },
        })
        .returning({
          structuralEnabled: routingSettings.structuralEnabled,
          cascadeEnabled: routingSettings.cascadeEnabled,
        });
      const row = rows[0];
      if (!row) throw new Error('routingSettings upsert returned no row');
      return row;
    },
  };
}

export function buildPersistencePort(db: Db): PersistencePort {
  return {
    agents: createOwnedRepository(db, agents as unknown as AnyOwnedTable),
    providers: {
      ...createOwnedRepository(db, providers as unknown as AnyOwnedTable),
      // E10.2: delete + re-compact tier positions in one transaction, so a
      // cascade that removed a position-0 model leaves the tier routable.
      async remove(principal: Principal, id: string): Promise<boolean> {
        return db.transaction(async (tx) => {
          await lockOwnerTiers(tx, principal); // tier-first lock order (no deadlock w/ replaceForTier)
          const rows = await buildRemove(tx, providers, principal, id);
          if (rows.length === 0) return false;
          await compactTiers(tx, principal);
          return true;
        });
      },
    },
    tiers: createOwnedRepository(db, tiers as unknown as AnyOwnedTable),
    routingRules: createOwnedRepository(db, routingRules as unknown as AnyOwnedTable),
    notificationChannels: createOwnedRepository(
      db,
      notificationChannels as unknown as AnyOwnedTable,
    ),
    budgets: createOwnedRepository(db, budgets as unknown as AnyOwnedTable),
    models: createModelAccessor(db),
    routingEntries: createRoutingEntryAccessor(db),
    requestLogs: createRequestLogAccessor(db),
    requestAttempts: createRequestAttemptAccessor(db),
    analytics: createAnalyticsAccessor(db),
    routingSettings: createRoutingSettingsAccessor(db),
    pricing: createPricingCatalog(db),
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
