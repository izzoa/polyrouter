import { and, asc, eq, gt, gte, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { BATCH_JOB_TERMINAL_STATUSES } from '@polyrouter/shared';
import {
  batchJobs,
  models,
  providers,
  type BatchJobMaintenance,
  type ModelMaintenance,
  type PersistenceMaintenance,
  type ProviderMaintenance,
  type ReservationMaintenance,
} from '@polyrouter/shared/server';
import type { Db } from './database.internal';

/** Instance-level model maintenance (add-model-variant-detection). NOT
 * principal-scoped by design: it re-derives each model's classification from
 * THAT model's own provider (the join below), so no value is ever computed from,
 * or written on behalf of, another tenant. It holds no policy — the caller passes
 * the pure derivation, so the token allowlist and the host->family map stay in
 * one shared module instead of being re-expressed (and drifting) in SQL. */
function createModelMaintenance(db: Db): ModelMaintenance {
  return {
    async classifyVariants(derive) {
      const rows = await db
        .select({
          id: models.id,
          externalModelId: models.externalModelId,
          variant: models.variant,
          providerBaseUrl: providers.baseUrl,
        })
        .from(models)
        .innerJoin(providers, eq(models.providerId, providers.id));
      let updated = 0;
      for (const row of rows) {
        const next = derive({
          providerBaseUrl: row.providerBaseUrl,
          externalModelId: row.externalModelId,
        });
        // Write ONLY on a real difference: a converged database takes zero writes,
        // which is what makes running this on every boot safe.
        if (next === row.variant) continue;
        await db.update(models).set({ variant: next }).where(eq(models.id, row.id));
        updated += 1;
      }
      return { scanned: rows.length, updated };
    },
  };
}

const TERMINAL_LIST = sql.raw(BATCH_JOB_TERMINAL_STATUSES.map((s) => `'${s}'`).join(', '));
const notTerminal = () => sql`${batchJobs.status} NOT IN (${TERMINAL_LIST})`;

/** The poller's sweep (add-batch-inference D19): non-terminal jobs across owners,
 * each carrying its owner. Deliberately a LIST, never a by-id read — the poller
 * acts on what it swept, under the principal it derives from each row. */
function createBatchJobMaintenance(db: Db): BatchJobMaintenance {
  return {
    async listNonTerminal(limit) {
      return db
        .select()
        .from(batchJobs)
        .where(notTerminal())
        .orderBy(asc(batchJobs.updatedAt), asc(batchJobs.id))
        .limit(Math.max(0, limit));
    },
  };
}

/** The reconciler's pending read (spend-limits D8): Σ reserved ceilings of one
 * owner's non-terminal jobs submitted in the period. A null ceiling (no finite
 * bound, admitted under no block budget) contributes nothing. */
function createReservationMaintenance(db: Db): ReservationMaintenance {
  return {
    async pendingMicrosFor(ownerUserId, agentId, start, endExclusive) {
      const conds = [
        eq(batchJobs.ownerUserId, ownerUserId),
        notTerminal(),
        gte(batchJobs.submittedAt, start),
        lt(batchJobs.submittedAt, endExclusive),
        ...(agentId !== null ? [eq(batchJobs.agentId, agentId)] : []),
      ];
      const rows = await db
        .select({
          micros: sql<string>`coalesce(sum(${batchJobs.reservedCeilingMicros}), 0)::bigint`,
        })
        .from(batchJobs)
        .where(and(...conds));
      return Number(rows[0]?.micros ?? 0);
    },
  };
}

/** The OAuth refresh sweep's listing (add-provider-health-signals): connected,
 * credentialed, not-errored OAuth providers across owners, id-paged (the partial
 * `provider_oauth_sweep_idx`), each carrying its owner — and nothing secret. */
function createProviderMaintenance(db: Db): ProviderMaintenance {
  return {
    async listOauthConnected({ afterId, limit }) {
      return db
        .select({
          id: providers.id,
          ownerUserId: providers.ownerUserId,
          credentialExpiresAt: providers.credentialExpiresAt,
        })
        .from(providers)
        .where(
          and(
            isNotNull(providers.oauthPreset),
            isNotNull(providers.encryptedCredentials),
            isNull(providers.credentialError),
            ...(afterId !== null ? [gt(providers.id, afterId)] : []),
          ),
        )
        .orderBy(asc(providers.id))
        .limit(Math.max(0, limit));
    },
    async listCatalogRefreshable({ afterId, limit, includeLocal }) {
      return db
        .select({ id: providers.id, ownerUserId: providers.ownerUserId })
        .from(providers)
        .where(
          and(
            includeLocal
              ? or(isNotNull(providers.encryptedCredentials), eq(providers.kind, 'local'))
              : and(isNotNull(providers.encryptedCredentials), ne(providers.kind, 'local')),
            isNull(providers.credentialError),
            ...(afterId !== null ? [gt(providers.id, afterId)] : []),
          ),
        )
        .orderBy(asc(providers.id))
        .limit(Math.max(0, limit));
    },
  };
}

/** Built inside the persistence module over the PRIVATE handle; only the
 * `PERSISTENCE_MAINTENANCE` token leaves it, and only through the maintenance
 * module (see `maintenance.module.ts`). No member returns a query builder or a
 * raw handle. */
export function buildPersistenceMaintenance(db: Db): PersistenceMaintenance {
  return {
    models: createModelMaintenance(db),
    batchJobs: createBatchJobMaintenance(db),
    reservations: createReservationMaintenance(db),
    providers: createProviderMaintenance(db),
  };
}
