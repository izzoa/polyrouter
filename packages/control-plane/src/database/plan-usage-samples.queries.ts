import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, notInArray, or } from 'drizzle-orm';
import {
  ownershipPredicate,
  planUsageSamples,
  providers,
  type PlanUsageSampleAccessor,
  type PlanUsageSampleInput,
  type PlanUsageSampleMaintenance,
  type PlanUsageScheduleRow,
  type Principal,
} from '@polyrouter/shared/server';
import type { Db } from './database.internal';

/**
 * The plan-usage history (add-subscription-usage-history, design D4/D5). Query builders are
 * separated from execution, as in `queries.ts`, so a unit test can assert the ownership predicate
 * and the conflict clause in the generated SQL without a database.
 *
 * Samples are owned THROUGH their provider (like models): the owner read joins the parent and
 * applies the ownership predicate. The writes are the usage schedule's system writes (the
 * maintenance surface), keyed on provider ids the schedule's own listing produced.
 */

/** Whether an error (or anything on its `cause` chain) carries the PostgreSQL SQLSTATE `code`. */
function isPgError(err: unknown, code: string): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 4 && cur; i += 1) {
    if ((cur as { code?: unknown }).code === code) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** 23503 = foreign_key_violation: the provider was deleted between the listing and the insert. */
const FOREIGN_KEY_VIOLATION = '23503';

export function buildListPlanUsageSamples(
  db: Db,
  principal: Principal,
  providerId: string,
  sinceByWindow: ReadonlyMap<string, Date>,
  otherwiseSince?: Date,
) {
  const keys = [...sinceByWindow.keys()];
  const perWindow = keys.map((key) =>
    and(
      eq(planUsageSamples.windowKey, key),
      gte(planUsageSamples.observedAt, sinceByWindow.get(key)!),
    ),
  );
  const others =
    otherwiseSince === undefined
      ? []
      : [
          keys.length === 0
            ? gte(planUsageSamples.observedAt, otherwiseSince)
            : and(
                notInArray(planUsageSamples.windowKey, keys),
                gte(planUsageSamples.observedAt, otherwiseSince),
              ),
        ];
  return db
    .select({
      windowKey: planUsageSamples.windowKey,
      usedPercent: planUsageSamples.usedPercent,
      resetAt: planUsageSamples.resetAt,
      observedAt: planUsageSamples.observedAt,
    })
    .from(planUsageSamples)
    .innerJoin(providers, eq(planUsageSamples.providerId, providers.id))
    .where(
      and(
        eq(planUsageSamples.providerId, providerId),
        // The ownership predicate on the PARENT, in the same statement (invariant 5).
        ownershipPredicate(providers, principal),
        or(...perWindow, ...others),
      ),
    )
    .orderBy(asc(planUsageSamples.observedAt), asc(planUsageSamples.windowKey));
}

export function buildInsertPlanUsageSamples(db: Db, samples: readonly PlanUsageSampleInput[]) {
  return db
    .insert(planUsageSamples)
    .values(
      samples.map((s) => ({
        providerId: s.providerId,
        windowKey: s.windowKey,
        usedPercent: s.usedPercent,
        resetAt: s.resetAt,
        observedAt: s.observedAt,
      })),
    )
    .onConflictDoNothing({
      target: [
        planUsageSamples.providerId,
        planUsageSamples.windowKey,
        planUsageSamples.observedAt,
      ],
    })
    .returning({ id: planUsageSamples.id });
}

export function buildPrunePlanUsageSamples(db: Db, before: Date, limit: number) {
  // A bounded batch: the ids of at most `limit` expired samples (the `observed_at` index), then
  // one DELETE of exactly those, so one prune never holds a long lock on a large table.
  const victims = db
    .select({ id: planUsageSamples.id })
    .from(planUsageSamples)
    .where(lt(planUsageSamples.observedAt, before))
    .limit(Math.max(0, Math.floor(limit)));
  return db
    .delete(planUsageSamples)
    .where(inArray(planUsageSamples.id, victims))
    .returning({ id: planUsageSamples.id });
}

export function buildListPlanUsageScheduled(db: Db, afterId: string | null, limit: number) {
  return db
    .select({
      id: providers.id,
      ownerUserId: providers.ownerUserId,
      kind: providers.kind,
      protocol: providers.protocol,
      baseUrl: providers.baseUrl,
      oauthPreset: providers.oauthPreset,
      keyPreset: providers.keyPreset,
      checkPlanUsage: providers.checkPlanUsage,
      credentialError: providers.credentialError,
    })
    .from(providers)
    .where(
      and(
        eq(providers.kind, 'subscription'),
        or(isNotNull(providers.oauthPreset), isNotNull(providers.keyPreset)),
        isNotNull(providers.encryptedCredentials),
        eq(providers.checkPlanUsage, true),
        isNull(providers.credentialError),
        ...(afterId !== null ? [gt(providers.id, afterId)] : []),
      ),
    )
    .orderBy(asc(providers.id))
    .limit(Math.max(0, limit));
}

export function createPlanUsageSampleAccessor(db: Db): PlanUsageSampleAccessor {
  return {
    async listPlanUsageSamples(principal, providerId, sinceByWindow, otherwiseSince) {
      if (sinceByWindow.size === 0 && otherwiseSince === undefined) return [];
      return buildListPlanUsageSamples(db, principal, providerId, sinceByWindow, otherwiseSince);
    },
  };
}

export function createPlanUsageSampleMaintenance(db: Db): PlanUsageSampleMaintenance {
  return {
    async insertPlanUsageSamples(samples) {
      if (samples.length === 0) return 0;
      // One statement per provider, so a provider deleted between the listing and this write
      // (a foreign-key violation) costs only its own samples, never the rest of the tick's.
      const byProvider = new Map<string, PlanUsageSampleInput[]>();
      for (const s of samples) {
        const group = byProvider.get(s.providerId);
        if (group === undefined) byProvider.set(s.providerId, [s]);
        else group.push(s);
      }
      let inserted = 0;
      for (const group of byProvider.values()) {
        try {
          inserted += (await buildInsertPlanUsageSamples(db, group)).length;
        } catch (err) {
          if (isPgError(err, FOREIGN_KEY_VIOLATION)) continue;
          throw err;
        }
      }
      return inserted;
    },
    async prunePlanUsageSamples(before, limit) {
      if (limit <= 0) return 0;
      return (await buildPrunePlanUsageSamples(db, before, limit)).length;
    },
  };
}

/** The usage schedule's provider listing (design D1), for `createProviderMaintenance`. */
export async function listPlanUsageScheduled(
  db: Db,
  page: { afterId: string | null; limit: number },
): Promise<PlanUsageScheduleRow[]> {
  return buildListPlanUsageScheduled(db, page.afterId, page.limit);
}
