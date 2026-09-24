import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
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
  pricingRefreshRuns,
  routingSettings,
  semanticLearningEvents,
  thresholdCalibrationEvents,
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
  type ProviderAccessor,
  type ProviderHealthPatch,
  type ProviderIncarnation,
  type ProviderPatch,
  type ProviderRow,
  type RequestAttemptAccessor,
  type RequestLogAccessor,
  type RoutingEntryAccessor,
  type RoutingSettingsAccessor,
  type CalibrationEventsAccessor,
  type SemanticLearningEventsAccessor,
  type SemanticLearningEventInput,
  type SemanticLearningEventRowView,
  type TierRow,
  replaceEntryModelId,
} from '@polyrouter/shared/server';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createAnalyticsAccessor } from './analytics.queries';
import { createBatchJobAccessor } from './batch-jobs.queries';
import { createBodyCaptureAccessor } from './body-capture.queries';
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

/** Only while the row still has the observation's incarnation — the credential
 * ciphertext, base_url, and protocol it was made against (add-provider-health-
 * signals). Null-safe on the nullable columns. */
function incarnationMatches(guard: ProviderIncarnation) {
  return and(
    guard.envelope === null
      ? isNull(providers.encryptedCredentials)
      : eq(providers.encryptedCredentials, guard.envelope),
    guard.baseUrl === null ? isNull(providers.baseUrl) : eq(providers.baseUrl, guard.baseUrl),
    eq(providers.protocol, guard.protocol),
  );
}

/** The provider health writes (add-provider-health-signals). Every write is ONE
 * owner-scoped UPDATE that bumps `health_rev` and stamps the written record's
 * revision from the same SET — Postgres evaluates every SET expression against
 * the row version being replaced, and row locks serialize concurrent UPDATEs
 * (READ COMMITTED re-checks the WHERE on the committed version), so revisions are
 * a total recording order with the row as the only authority. */
function createProviderHealthWrites(
  db: Db,
): Pick<ProviderAccessor, 'setHealth' | 'updateResettingHealth'> {
  const bump = sql`${providers.healthRev} + 1`;
  return {
    async setHealth(
      principal: Principal,
      id: string,
      patch: ProviderHealthPatch,
      guard: ProviderIncarnation,
    ) {
      const owned = and(eq(providers.id, id), ownershipPredicate(providers, principal));
      if (patch.record === 'check') {
        const rows = await db
          .update(providers)
          .set({
            status: patch.status,
            // A kind describes a failure only — normalized away otherwise.
            lastErrorKind: patch.status === 'error' ? patch.kind : null,
            statusSource: patch.source,
            statusChangedAt: sql`now()`,
            statusRev: bump,
            healthRev: bump,
          })
          .where(and(owned, incarnationMatches(guard)))
          .returning({ id: providers.id });
        return rows.length > 0;
      }
      const rows = await db
        .update(providers)
        .set({
          trafficState: patch.state,
          trafficErrorKind: patch.state === 'failing' ? patch.kind : null,
          trafficAt: sql`now()`,
          trafficSeq: patch.seq,
          trafficRev: bump,
          healthRev: bump,
        })
        .where(
          and(
            owned,
            incarnationMatches(guard),
            // The breaker-issued sequence totally orders one provider's traffic
            // observations: a delayed older write never overwrites a newer one.
            or(isNull(providers.trafficSeq), lt(providers.trafficSeq, patch.seq)),
          ),
        )
        .returning({ id: providers.id });
      return rows.length > 0;
    },
    async updateResettingHealth(
      principal: Principal,
      id: string,
      patch: ProviderPatch,
      source: 'edit' | 'reconnect',
    ) {
      const clean = stripProtected(patch);
      const rows = await db
        .update(providers)
        .set({
          ...clean,
          // The new incarnation starts with no health of its own: the check
          // record resets and the traffic record clears in the SAME statement
          // that changes the credential/endpoint, so nothing can interleave.
          status: 'unknown',
          lastErrorKind: null,
          statusSource: source,
          statusChangedAt: sql`now()`,
          statusRev: bump,
          trafficState: null,
          trafficErrorKind: null,
          trafficAt: null,
          trafficSeq: null,
          trafficRev: null,
          healthRev: bump,
        })
        .where(and(eq(providers.id, id), ownershipPredicate(providers, principal)))
        .returning();
      return (rows[0] as ProviderRow | undefined) ?? null;
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
      // instead of racing to a unique violation. Only the sync-owned fields are
      // updated — display_name/last_synced_at, the listed_* display estimates, and
      // the derived variant — never prices/capabilities (those are #8's).
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
        // Provider-listed DISPLAY estimate (add-provider-price-sync-and-edit): always
        // rewritten on sync (present-with-null CLEARS a stale estimate). Never the
        // billing user-price columns (those stay #8's, untouched here).
        if ('listedInputPricePer1m' in rest)
          set['listedInputPricePer1m'] = rest['listedInputPricePer1m'];
        if ('listedOutputPricePer1m' in rest)
          set['listedOutputPricePer1m'] = rest['listedOutputPricePer1m'];
        if ('listedIsFree' in rest) set['listedIsFree'] = rest['listedIsFree'];
        if ('listedPriceCapturedAt' in rest)
          set['listedPriceCapturedAt'] = rest['listedPriceCapturedAt'];
        // Derived variant (add-model-variant-detection): MUST be in the conflict set.
        // Written only on INSERT, a classification would freeze at the row's first
        // sync — an id whose variant changed, or one wrongly classified before a
        // provider was repointed, could never be corrected by a re-sync.
        if ('variant' in rest) set['variant'] = rest['variant'];
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
          .where(
            and(eq(models.id, id), inArray(models.providerId, ownedProviderIds(tx, principal))),
          )
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
    async clearListedPricingForProvider(principal, providerId) {
      // Drop the provider-listed DISPLAY estimates when the endpoint changes
      // (add-provider-price-sync-and-edit) — a price captured from the prior base_url/
      // protocol must not linger; the next sync repopulates. Owner-scoped; never the
      // billing user-price columns.
      const rows = await db
        .update(models)
        .set({
          listedInputPricePer1m: null,
          listedOutputPricePer1m: null,
          listedIsFree: null,
          listedPriceCapturedAt: null,
          // The classification was derived from the OLD endpoint's billing family
          // (add-model-variant-detection): keeping it would leave a retained model
          // permanently non-routable on a provider now pointed elsewhere.
          variant: null,
          // Likewise the capability CLAIM (honest-model-capabilities): it is the
          // old provider's statement about the old provider's models, and the new
          // endpoint has said nothing. The next sync repopulates it.
          listedSupportsTools: null,
          listedSupportsVision: null,
          listedSupportsReasoning: null,
          listedContextWindow: null,
          listedCapabilitiesCapturedAt: null,
        })
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
        await db
          .update(routingEntries)
          .set({ position: i })
          .where(eq(routingEntries.id, entries[i]!.id));
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
    async replaceForTier(principal, tierId, ordered) {
      const orderedModelIds = ordered.map(replaceEntryModelId);
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

        // A member that does not STATE a mode keeps the one already stored for that
        // model in this tier (add-batch-mode-routing D11). Read before the delete,
        // inside the same transaction, so a concurrent edit cannot interleave.
        const priorMode = new Map<string, string>();
        for (const row of await tx
          .select({ modelId: routingEntries.modelId, mode: routingEntries.mode })
          .from(routingEntries)
          .where(eq(routingEntries.tierId, tierId))) {
          priorMode.set(row.modelId, row.mode);
        }

        // All-or-nothing replace: clear the chain, reinsert at positions 0..N-1.
        await tx.delete(routingEntries).where(eq(routingEntries.tierId, tierId));
        const entries =
          ordered.length > 0
            ? await tx
                .insert(routingEntries)
                .values(
                  ordered.map((e, position) => {
                    const modelId = replaceEntryModelId(e);
                    const stated = typeof e === 'string' ? undefined : e.mode;
                    return {
                      tierId,
                      modelId,
                      position,
                      mode: stated ?? priorMode.get(modelId) ?? 'any',
                    };
                  }),
                )
                .returning()
            : [];
        return { status: 'ok' as const, entries };
      });
    },
  };
}

/** The transaction-local `lock_timeout` elapsed while waiting on an advisory lock
 * (add-subscription-oauth) — the transaction is aborted and its connection released. */
export class AdvisoryLockTimeoutError extends Error {
  constructor() {
    super('advisory lock wait timed out');
    this.name = 'AdvisoryLockTimeoutError';
  }
}

function isLockTimeout(err: unknown): boolean {
  const code = (err as { code?: string; cause?: { code?: string } }).code;
  const causeCode = (err as { cause?: { code?: string } }).cause?.code;
  return code === '55P03' || causeCode === '55P03';
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
    async priceAtMany(keys, at) {
      // ONE query for the effective version of each requested key as of `at`
      // (add-provider-price-sync-and-edit) — DISTINCT ON (model_key) ordered by
      // valid_from desc, filtered to the given keys. Never N×priceAt / full scan.
      if (keys.length === 0) return [];
      return db
        .selectDistinctOn([modelPrices.modelKey])
        .from(modelPrices)
        .where(and(inArray(modelPrices.modelKey, [...keys]), lte(modelPrices.validFrom, at)))
        .orderBy(modelPrices.modelKey, desc(modelPrices.validFrom));
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
          maxOutputTokens: entry.maxOutputTokens ?? null,
          batchInputPricePer1m: entry.batchInputPricePer1m ?? null,
          batchOutputPricePer1m: entry.batchOutputPricePer1m ?? null,
          // Tri-state (honest-model-capabilities): null = unknown reaches the column
          // as null. This is the LAST layer before the write, so a `?? false` here
          // would silently undo the honest null the service just resolved.
          supportsTools: entry.supportsTools ?? null,
          supportsVision: entry.supportsVision ?? null,
          supportsReasoning: entry.supportsReasoning ?? null,
          isFree: entry.isFree ?? false,
          source: entry.source,
          validFrom: entry.validFrom,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('insertVersion returned no row');
      return row;
    },
    async insertRefreshRun(input) {
      // clock_timestamp() = COMPLETION time (r3-Med-3): the column default
      // now() is the transaction's START, which can precede a long advisory
      // lock wait — the ledger must record when the refresh finished.
      await db.insert(pricingRefreshRuns).values({
        kind: input.kind,
        added: input.added,
        skipped: input.skipped,
        createdAt: sql`clock_timestamp()`,
      });
    },
    async statusMeta(now) {
      const iso = (v: Date | string): string =>
        v instanceof Date ? v.toISOString() : new Date(v).toISOString();
      // ONE transaction (r3-Med-3): the three reads see a single snapshot —
      // a refresh committing mid-read can't pair an old count with a new
      // newest/lastRefresh. (Nested calls become a savepoint — harmless.)
      const [countRow, newest, lastRun] = await db.transaction(async (tx) => {
        const [c] = await tx
          .select({ value: sql<number>`count(distinct ${modelPrices.modelKey})::int` })
          .from(modelPrices)
          .where(lte(modelPrices.validFrom, now));
        const [n] = await tx
          .select()
          .from(modelPrices)
          .orderBy(desc(modelPrices.createdAt), desc(modelPrices.id))
          .limit(1);
        const [r] = await tx
          .select()
          .from(pricingRefreshRuns)
          .where(eq(pricingRefreshRuns.kind, 'litellm'))
          .orderBy(desc(pricingRefreshRuns.createdAt))
          .limit(1);
        return [c, n, r] as const;
      });
      return {
        entryCount: countRow?.value ?? 0,
        newest: newest
          ? {
              source: newest.source,
              validFrom: iso(newest.validFrom),
              appliedAt: iso(newest.createdAt),
            }
          : null,
        lastRefresh: lastRun
          ? { at: iso(lastRun.createdAt), added: lastRun.added, skipped: lastRun.skipped }
          : null,
      };
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
    async insertManyReturning(principal, rows) {
      if (rows.length === 0) return { insertedIds: [] };
      assertUserPrincipal(principal);
      const owned = rows.map((r) => ({ ...r, ownerUserId: principal.userId, orgId: null }));
      // RETURNING after DO NOTHING yields exactly the rows that landed — a replay
      // of already-settled ids returns none (D9: metrics once per row).
      const landed = await db
        .insert(requestLogs)
        .values(owned)
        .onConflictDoNothing({ target: requestLogs.id })
        .returning({ id: requestLogs.id });
      return { insertedIds: landed.map((r) => r.id) };
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

/** The full settings value selection (auto-layer flags + calibration). */
const SETTINGS_VALUE_COLUMNS = {
  structuralEnabled: routingSettings.structuralEnabled,
  cascadeEnabled: routingSettings.cascadeEnabled,
  semanticEnabled: routingSettings.semanticEnabled,
  semanticLearningEnabled: routingSettings.semanticLearningEnabled,
  semanticLearningEpoch: routingSettings.semanticLearningEpoch,
  semanticLearningGeneration: routingSettings.semanticLearningGeneration,
  calibrationEnabled: routingSettings.calibrationEnabled,
  calibratedHigh: routingSettings.calibratedHigh,
  calibratedLow: routingSettings.calibratedLow,
  calibratedAnchorHigh: routingSettings.calibratedAnchorHigh,
  calibratedAnchorLow: routingSettings.calibratedAnchorLow,
  calibrationEpoch: routingSettings.calibrationEpoch,
  membershipGeneration: routingSettings.membershipGeneration,
};

/** Per-tenant auto-layer preference (#20) + threshold calibration
 * (add-auto-threshold-calibration). Owner-scoped read + one-row-per-owner
 * upsert (owner forced from the principal; conflict on the unique owner
 * index). The upsert NEVER touches the calibrated quad or epoch, and an
 * omitted `calibrationEnabled` preserves the stored flag (older clients
 * replaying only the layer flags cannot silently disable calibration). */
function createRoutingSettingsAccessor(db: Db): RoutingSettingsAccessor {
  return {
    async get(principal) {
      const rows = await db
        .select(SETTINGS_VALUE_COLUMNS)
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
            // First write from a legacy client (semantic omitted): inherit
            // the structural intent, keeping the semantic⇒structural check
            // true by construction (add-semantic-routing D7). Learning always
            // defaults OFF — never inherited (add-semantic-learning).
            semanticEnabled: value.semanticEnabled ?? value.structuralEnabled,
            semanticLearningEnabled: value.semanticLearningEnabled ?? false,
            ...(value.calibrationEnabled !== undefined
              ? { calibrationEnabled: value.calibrationEnabled }
              : {}),
          }) as typeof routingSettings.$inferInsert,
        )
        .onConflictDoUpdate({
          target: routingSettings.ownerUserId,
          set: {
            structuralEnabled: value.structuralEnabled,
            cascadeEnabled: value.cascadeEnabled,
            // ATOMIC dependency-down normalization (D7): provided → write;
            // omitted → preserve the STORED value AND the new structural flag
            // (a legacy full opt-out clears semantic; stored semantic can
            // never silently re-enable structural). One statement, no
            // unlocked pre-read. Learning depends on the EFFECTIVE semantic
            // (add-semantic-learning): omitted learning is preserved unless
            // the effective semantic falls to false, which clears it too. The
            // learning epoch/generation are managed by the sweep/revert — never
            // touched here.
            semanticEnabled:
              value.semanticEnabled !== undefined
                ? value.semanticEnabled
                : sql`${routingSettings.semanticEnabled} AND ${value.structuralEnabled}`,
            semanticLearningEnabled:
              value.semanticLearningEnabled !== undefined
                ? value.semanticLearningEnabled
                : sql`${routingSettings.semanticLearningEnabled} AND ${
                    value.semanticEnabled !== undefined
                      ? sql`${value.semanticEnabled}`
                      : sql`(${routingSettings.semanticEnabled} AND ${value.structuralEnabled})`
                  }`,
            // Omission preserves; the quad/epoch are NEVER touched here.
            ...(value.calibrationEnabled !== undefined
              ? { calibrationEnabled: value.calibrationEnabled }
              : {}),
            updatedAt: new Date(),
          },
        })
        .returning(SETTINGS_VALUE_COLUMNS);
      const row = rows[0];
      if (!row) throw new Error('routingSettings upsert returned no row');
      return row;
    },
    async setCalibrated(principal, quad, expected, events) {
      // Conditional row-locked write: the transaction re-reads FOR UPDATE and
      // writes ONLY when the row still matches the observed state — a
      // concurrent disable/revert/rebase wins and this returns false.
      return db.transaction(async (tx) => {
        const current = await tx
          .select(SETTINGS_VALUE_COLUMNS)
          .from(routingSettings)
          .where(ownershipPredicate(routingSettings, principal))
          .limit(1)
          .for('update');
        const row = current[0];
        if (!row) return false;
        if (row.calibrationEpoch !== expected.epoch) return false;
        // Membership moved under the evidence this move was computed from, so
        // the move is stale: no-op and recompute next occurrence. Omitted by
        // hygiene and revert, which are correct against any population.
        if (
          expected.membershipGeneration !== undefined &&
          row.membershipGeneration !== expected.membershipGeneration
        ) {
          return false;
        }
        if (expected.enabled !== null && row.calibrationEnabled !== expected.enabled) return false;
        if (
          row.calibratedHigh !== expected.high ||
          row.calibratedLow !== expected.low ||
          row.calibratedAnchorHigh !== expected.anchorHigh ||
          row.calibratedAnchorLow !== expected.anchorLow
        ) {
          return false;
        }
        const resolved = typeof events === 'function' ? events(row) : events;
        const list = Array.isArray(resolved) ? resolved : [resolved];
        await tx
          .update(routingSettings)
          .set({
            calibratedHigh: quad === null ? null : quad.high,
            calibratedLow: quad === null ? null : quad.low,
            calibratedAnchorHigh: quad === null ? null : quad.anchorHigh,
            calibratedAnchorLow: quad === null ? null : quad.anchorLow,
            // The epoch bumps per threshold EVENT (r3-Med-5): a two-edge move
            // advances it twice — evidence staleness is per event, per contract.
            calibrationEpoch: row.calibrationEpoch + list.length,
            updatedAt: new Date(),
          })
          .where(ownershipPredicate(routingSettings, principal));
        // One audit row per applied edge, in order, SAME transaction — a move
        // without its evidence can never be observed.
        // Ordinal = within-transaction apply order (r3-Med-5): both events
        // share one txn timestamp, so it is the deterministic secondary sort.
        for (const [i, input] of list.entries()) {
          await tx.insert(thresholdCalibrationEvents).values(
            buildInsertValues(principal, {
              trigger: input.trigger,
              oldHigh: input.oldHigh,
              oldLow: input.oldLow,
              newHigh: input.newHigh,
              newLow: input.newLow,
              anchorHigh: input.anchorHigh,
              anchorLow: input.anchorLow,
              windowFrom: input.windowFrom ?? null,
              windowTo: input.windowTo ?? null,
              edge: input.edge ?? null,
              edgeSamples: input.edgeSamples ?? null,
              edgeFailures: input.edgeFailures ?? null,
              reason: input.reason,
              ordinal: i,
            }) as typeof thresholdCalibrationEvents.$inferInsert,
          );
        }
        return true;
      });
    },
    async clearCalibrated(principal, eventOf) {
      // USER-WINS revert (r3-Med-2): lock, clear whatever pair is present,
      // event from the LOCKED values — a mid-flight calibrator move cannot
      // turn the user's revert into a silent no-op.
      return db.transaction(async (tx) => {
        const current = await tx
          .select(SETTINGS_VALUE_COLUMNS)
          .from(routingSettings)
          .where(ownershipPredicate(routingSettings, principal))
          .limit(1)
          .for('update');
        const row = current[0];
        if (!row || row.calibratedHigh === null) return false; // nothing to clear — no event
        await tx
          .update(routingSettings)
          .set({
            calibratedHigh: null,
            calibratedLow: null,
            calibratedAnchorHigh: null,
            calibratedAnchorLow: null,
            calibrationEpoch: row.calibrationEpoch + 1,
            updatedAt: new Date(),
          })
          .where(ownershipPredicate(routingSettings, principal));
        const input = eventOf(row);
        await tx.insert(thresholdCalibrationEvents).values(
          buildInsertValues(principal, {
            trigger: input.trigger,
            oldHigh: input.oldHigh,
            oldLow: input.oldLow,
            newHigh: input.newHigh,
            newLow: input.newLow,
            anchorHigh: input.anchorHigh,
            anchorLow: input.anchorLow,
            windowFrom: input.windowFrom ?? null,
            windowTo: input.windowTo ?? null,
            edge: input.edge ?? null,
            edgeSamples: input.edgeSamples ?? null,
            edgeFailures: input.edgeFailures ?? null,
            reason: input.reason,
            ordinal: 0,
          }) as typeof thresholdCalibrationEvents.$inferInsert,
        );
        return true;
      });
    },
    async listCalibrationEnabled() {
      const rows = await db
        .select({ ownerUserId: routingSettings.ownerUserId, ...SETTINGS_VALUE_COLUMNS })
        .from(routingSettings)
        .where(eq(routingSettings.calibrationEnabled, true));
      return rows.map(({ ownerUserId, ...value }) => ({ ownerUserId, value }));
    },
    async listWithCalibratedPair() {
      const rows = await db
        .select({ ownerUserId: routingSettings.ownerUserId, ...SETTINGS_VALUE_COLUMNS })
        .from(routingSettings)
        .where(isNotNull(routingSettings.calibratedHigh));
      return rows.map(({ ownerUserId, ...value }) => ({ ownerUserId, value }));
    },
    async recordLearningApply(principal, expected, event) {
      // The sweep's Postgres-authoritative apply (add-semantic-learning D5): CAS
      // the learning coords under a row lock and advance the generation, with the
      // audit insert in the SAME transaction so a move without its evidence can
      // never be observed. Idempotent across the two crash-recovery paths.
      return db.transaction(async (tx) => {
        const current = await tx
          .select(SETTINGS_VALUE_COLUMNS)
          .from(routingSettings)
          .where(ownershipPredicate(routingSettings, principal))
          .limit(1)
          .for('update');
        const row = current[0];
        if (!row) return 'stale';
        const atExpected =
          row.semanticLearningEpoch === expected.epoch &&
          row.semanticLearningGeneration === expected.generation;
        // The RESULTING coords this occurrence would produce (generation = G+1).
        const atApplied =
          row.semanticLearningEpoch === event.epoch &&
          row.semanticLearningGeneration === event.generation;
        // Neither the pre- nor post-apply coords ⇒ a concurrent revert/apply won.
        if (!atExpected && !atApplied) return 'stale';
        const inserted = await tx
          .insert(semanticLearningEvents)
          .values(learningEventValues(principal, event))
          .onConflictDoNothing({ target: semanticLearningEvents.occurrenceId })
          .returning({ id: semanticLearningEvents.id });
        if (atExpected) {
          if (inserted.length === 0) return 'duplicate'; // already audited (defensive)
          await tx
            .update(routingSettings)
            .set({
              semanticLearningGeneration: row.semanticLearningGeneration + 1,
              updatedAt: new Date(),
            })
            .where(ownershipPredicate(routingSettings, principal));
          return 'applied';
        }
        // atApplied: a prior attempt already committed this occurrence — the
        // caller (sweep) still needs to (idempotently) promote the Redis stage.
        return 'duplicate';
      });
    },
    async recordLearningDiscard(principal, event) {
      // A discard changes no coordinates (D9) — just an idempotent audit note.
      const inserted = await db
        .insert(semanticLearningEvents)
        .values(learningEventValues(principal, event))
        .onConflictDoNothing({ target: semanticLearningEvents.occurrenceId })
        .returning({ id: semanticLearningEvents.id });
      return inserted.length > 0;
    },
    async listSemanticLearningEnabled() {
      const rows = await db
        .select({ ownerUserId: routingSettings.ownerUserId, ...SETTINGS_VALUE_COLUMNS })
        .from(routingSettings)
        .where(eq(routingSettings.semanticLearningEnabled, true));
      return rows.map(({ ownerUserId, ...value }) => ({ ownerUserId, value }));
    },
    async revertLearning(principal, reason) {
      // USER-WINS: lock, bump the epoch (fences in-flight sweeps + inert reads),
      // reset the generation, audit — all in one transaction. The Redis delete is
      // a best-effort follow-up (the caller does it); the epoch bump is the fence.
      return db.transaction(async (tx) => {
        const current = await tx
          .select(SETTINGS_VALUE_COLUMNS)
          .from(routingSettings)
          .where(ownershipPredicate(routingSettings, principal))
          .limit(1)
          .for('update');
        const row = current[0];
        if (!row) return null;
        const epoch = row.semanticLearningEpoch + 1;
        await tx
          .update(routingSettings)
          .set({
            semanticLearningEpoch: epoch,
            semanticLearningGeneration: 0,
            updatedAt: new Date(),
          })
          .where(ownershipPredicate(routingSettings, principal));
        const userId = principal.kind === 'user' ? principal.userId : principal.orgId;
        await tx
          .insert(semanticLearningEvents)
          .values(
            learningEventValues(principal, {
              occurrenceId: `${userId}:revert:${String(epoch)}`,
              trigger: 'revert',
              epoch,
              generation: 0,
              reason,
            }),
          )
          .onConflictDoNothing({ target: semanticLearningEvents.occurrenceId });
        return { epoch, generation: 0 };
      });
    },
  };
}

/** Scalars-only insert values for a learning audit row (invariant 8). */
function learningEventValues(
  principal: Principal,
  event: SemanticLearningEventInput,
): typeof semanticLearningEvents.$inferInsert {
  return buildInsertValues(principal, {
    occurrenceId: event.occurrenceId,
    trigger: event.trigger,
    epoch: event.epoch,
    generation: event.generation,
    highSamples: event.highSamples ?? 0,
    lowSamples: event.lowSamples ?? 0,
    highDrift: event.highDrift ?? null,
    lowDrift: event.lowDrift ?? null,
    highSimilarity: event.highSimilarity ?? null,
    lowSimilarity: event.lowSimilarity ?? null,
    reason: event.reason,
  }) as typeof semanticLearningEvents.$inferInsert;
}

/** Owner-scoped learning history reads; the writes ride the sweep's transaction. */
function createSemanticLearningEventsAccessor(db: Db): SemanticLearningEventsAccessor {
  const iso = (v: Date | string | null): string =>
    v == null ? '' : v instanceof Date ? v.toISOString() : new Date(v).toISOString();
  const view = (r: typeof semanticLearningEvents.$inferSelect): SemanticLearningEventRowView => ({
    id: r.id,
    occurrenceId: r.occurrenceId,
    trigger: r.trigger,
    epoch: r.epoch,
    generation: r.generation,
    highSamples: r.highSamples,
    lowSamples: r.lowSamples,
    highDrift: r.highDrift,
    lowDrift: r.lowDrift,
    highSimilarity: r.highSimilarity,
    lowSimilarity: r.lowSimilarity,
    reason: r.reason,
    createdAt: iso(r.createdAt),
  });
  return {
    async list(principal, limit) {
      const rows = await db
        .select()
        .from(semanticLearningEvents)
        .where(ownershipPredicate(semanticLearningEvents, principal))
        .orderBy(desc(semanticLearningEvents.createdAt))
        .limit(limit);
      return rows.map(view);
    },
    async lastApply(principal) {
      const rows = await db
        .select()
        .from(semanticLearningEvents)
        .where(
          and(
            ownershipPredicate(semanticLearningEvents, principal),
            eq(semanticLearningEvents.trigger, 'apply'),
          ),
        )
        .orderBy(desc(semanticLearningEvents.createdAt))
        .limit(1);
      return rows[0] ? view(rows[0]) : null;
    },
  };
}

/** Owner-scoped calibration history reads; the writes ride `setCalibrated`. */
function createCalibrationEventsAccessor(db: Db): CalibrationEventsAccessor {
  const iso = (v: Date | string | null): string | null =>
    v == null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();
  return {
    async list(principal, limit, scope) {
      const rows = await db
        .select()
        .from(thresholdCalibrationEvents)
        .where(
          and(
            // Ownership FIRST, always: a foreign agent id then selects nothing
            // rather than reaching another tenant's rows (invariant 5).
            ownershipPredicate(thresholdCalibrationEvents, principal),
            scope === undefined
              ? undefined
              : scope === 'tenant'
                ? isNull(thresholdCalibrationEvents.agentId)
                : eq(thresholdCalibrationEvents.agentId, scope),
          ),
        )
        .orderBy(
          desc(thresholdCalibrationEvents.createdAt),
          desc(thresholdCalibrationEvents.ordinal),
        )
        .limit(limit);
      return rows.map((r) => ({
        id: r.id,
        trigger: r.trigger,
        oldHigh: r.oldHigh,
        oldLow: r.oldLow,
        newHigh: r.newHigh,
        newLow: r.newLow,
        anchorHigh: r.anchorHigh,
        anchorLow: r.anchorLow,
        windowFrom: iso(r.windowFrom),
        windowTo: iso(r.windowTo),
        edge: r.edge,
        edgeSamples: r.edgeSamples,
        edgeFailures: r.edgeFailures,
        reason: r.reason,
        createdAt: iso(r.createdAt) ?? '',
        agentId: r.agentId,
      }));
    },
  };
}

export function buildPersistencePort(db: Db): PersistencePort {
  return {
    agents: createOwnedRepository(db, agents as unknown as AnyOwnedTable),

    agentCalibration: {
      async listForCalibration(principal) {
        return db
          .select({
            id: agents.id,
            ownerUserId: agents.ownerUserId,
            name: agents.name,
            calibratedHigh: agents.calibratedHigh,
            calibratedLow: agents.calibratedLow,
            calibratedAnchorHigh: agents.calibratedAnchorHigh,
            calibratedAnchorLow: agents.calibratedAnchorLow,
            calibrationEpoch: agents.calibrationEpoch,
          })
          .from(agents)
          .where(ownershipPredicate(agents, principal));
      },

      async listWithCalibratedPair() {
        // Deliberately NOT owner-scoped: the hygiene pass runs under the
        // trusted scheduler and must see every tenant's agents, including
        // tenants that have switched calibration off.
        return db
          .select({
            id: agents.id,
            ownerUserId: agents.ownerUserId,
            calibratedHigh: agents.calibratedHigh,
            calibratedLow: agents.calibratedLow,
            calibratedAnchorHigh: agents.calibratedAnchorHigh,
            calibratedAnchorLow: agents.calibratedAnchorLow,
            calibrationEpoch: agents.calibrationEpoch,
          })
          .from(agents)
          .where(isNotNull(agents.calibratedHigh));
      },

      async activity(principal, agentId, range) {
        const [row] = await db
          .select({ rows: sql<number>`cast(count(*) as int)` })
          .from(requestLogs)
          .where(
            and(
              ownershipPredicate(requestLogs, principal),
              eq(requestLogs.agentId, agentId),
              gte(requestLogs.createdAt, range.from),
              lt(requestLogs.createdAt, range.to),
            ),
          );
        return { rows: row?.rows ?? 0 };
      },

      async setCalibrated(principal, agentId, quad, expected, tenantPin, events) {
        assertUserPrincipal(principal);
        // LOCK ORDER, always: routing_settings first, then the agent row. The
        // tenant write takes only the first, so this keeps the lock graph
        // acyclic and the two can never deadlock (design Decision 7).
        return db.transaction(async (tx) => {
          const settingsRows = await tx
            .select(SETTINGS_VALUE_COLUMNS)
            .from(routingSettings)
            .where(ownershipPredicate(routingSettings, principal))
            .limit(1)
            .for('update');
          const settings = settingsRows[0];
          if (!settings) return false;

          // Only a PROMOTION pins the parent. A clear or revert passes null:
          // both retreat to the level above and are correct against any parent,
          // and requiring the old tuple would make them unable to clear exactly
          // the stale pairs they exist to clear.
          if (tenantPin !== null) {
            if (
              settings.calibratedHigh !== tenantPin.high ||
              settings.calibratedLow !== tenantPin.low ||
              settings.calibrationEpoch !== tenantPin.epoch ||
              settings.membershipGeneration !== tenantPin.membershipGeneration
            ) {
              return false;
            }
          }

          const agentRows = await tx
            .select({
              id: agents.id,
              calibratedHigh: agents.calibratedHigh,
              calibratedLow: agents.calibratedLow,
              calibratedAnchorHigh: agents.calibratedAnchorHigh,
              calibratedAnchorLow: agents.calibratedAnchorLow,
              calibrationEpoch: agents.calibrationEpoch,
            })
            .from(agents)
            .where(and(eq(agents.id, agentId), ownershipPredicate(agents, principal)))
            .limit(1)
            .for('update');
          const agent = agentRows[0];
          if (!agent) return false;
          if (
            agent.calibratedHigh !== expected.high ||
            agent.calibratedLow !== expected.low ||
            agent.calibratedAnchorHigh !== expected.anchorHigh ||
            agent.calibratedAnchorLow !== expected.anchorLow ||
            agent.calibrationEpoch !== expected.epoch
          ) {
            return false;
          }

          await tx
            .update(agents)
            .set({
              calibratedHigh: quad?.high ?? null,
              calibratedLow: quad?.low ?? null,
              calibratedAnchorHigh: quad?.anchorHigh ?? null,
              calibratedAnchorLow: quad?.anchorLow ?? null,
              calibrationEpoch: agent.calibrationEpoch + 1,
            })
            .where(eq(agents.id, agentId));

          // The generation moves ONLY on a real membership transition. A
          // repeated or no-op revert must not bump it, or it would manufacture
          // failed tenant writes out of nothing — and a clear that bumped
          // unconditionally could drive a clear/fail/staler/clear cycle.
          const had = agent.calibratedHigh !== null;
          const has = quad !== null;
          if (had !== has) {
            await tx
              .update(routingSettings)
              .set({ membershipGeneration: settings.membershipGeneration + 1 })
              .where(ownershipPredicate(routingSettings, principal));
          }

          const list = Array.isArray(events) ? events : [events];
          if (list.length > 0) {
            await tx.insert(thresholdCalibrationEvents).values(
              list.map((e, i) => ({
                ownerUserId: principal.userId,
                agentId,
                trigger: e.trigger,
                oldHigh: e.oldHigh,
                oldLow: e.oldLow,
                newHigh: e.newHigh,
                newLow: e.newLow,
                anchorHigh: e.anchorHigh,
                anchorLow: e.anchorLow,
                windowFrom: e.windowFrom ?? null,
                windowTo: e.windowTo ?? null,
                edge: e.edge ?? null,
                edgeSamples: e.edgeSamples ?? null,
                edgeFailures: e.edgeFailures ?? null,
                reason: e.reason,
                ordinal: i,
              })),
            );
          }
          return true;
        });
      },
    },
    providers: {
      ...createOwnedRepository(db, providers as unknown as AnyOwnedTable),
      ...createProviderHealthWrites(db),
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
    bodyCapture: createBodyCaptureAccessor(db),
    calibrationEvents: createCalibrationEventsAccessor(db),
    semanticLearningEvents: createSemanticLearningEventsAccessor(db),
    pricing: createPricingCatalog(db),
    batchJobs: createBatchJobAccessor(db),
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
    async withAdvisoryLock(lockKey, fn, opts) {
      const timeoutMs = opts?.lockTimeoutMs;
      try {
        return await db.transaction(async (tx) => {
          if (timeoutMs !== undefined && Number.isInteger(timeoutMs) && timeoutMs > 0) {
            // SET LOCAL cannot be parameterized; the value is validated as a positive
            // integer above, never caller-supplied text.
            await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${String(timeoutMs)}`));
          }
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`);
          return fn(buildPersistencePort(tx));
        });
      } catch (err) {
        // 55P03 = lock_not_available (the transaction-local lock_timeout elapsed). The
        // tx has aborted and the connection is FREE — surface a typed timeout so the
        // caller can re-read-and-adopt instead of a detached waiter living on.
        if (timeoutMs !== undefined && isLockTimeout(err)) throw new AdvisoryLockTimeoutError();
        throw err;
      }
    },
  };
}
