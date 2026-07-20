import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  agents,
  bodyCaptureSettings,
  ownershipPredicate,
  requestBodies,
  requestBodyTombstones,
  requestLogs,
  type BodyCaptureAccessor,
  type BodyCaptureMode,
  type BodyCaptureSettingsValue,
} from '@polyrouter/shared/server';
import type { Db } from './database.internal';
import { buildInsertValues } from './queries';

const SETTINGS_COLUMNS = {
  mode: bodyCaptureSettings.mode,
  retentionDays: bodyCaptureSettings.retentionDays,
  captureEpoch: bodyCaptureSettings.captureEpoch,
  droppedCount: bodyCaptureSettings.droppedCount,
  lastPurgeAt: bodyCaptureSettings.lastPurgeAt,
  lastPurgeCount: bodyCaptureSettings.lastPurgeCount,
};

/** A stored mode outside the enum (CHECK-impossible, but fail-closed anyway). */
const asMode = (m: string): BodyCaptureMode =>
  m === 'errors_only' || m === 'all' ? m : 'off';

const toValue = (r: {
  mode: string;
  retentionDays: number | null;
  captureEpoch: number;
  droppedCount: number;
  lastPurgeAt: Date | null;
  lastPurgeCount: number;
}): BodyCaptureSettingsValue => ({ ...r, mode: asMode(r.mode) });

/** Body-capture persistence (add-body-capture). Every deletion-vs-writer race
 * is settled by ONE serialization point: the owner's settings row locked FOR
 * UPDATE — the guarded insert re-reads epoch/tombstones/retention post-lock,
 * and every purge/delete bumps state under the same lock (design D9). */
export function createBodyCaptureAccessor(db: Db): BodyCaptureAccessor {
  return {
    async getSettings(principal) {
      const rows = await db
        .select(SETTINGS_COLUMNS)
        .from(bodyCaptureSettings)
        .where(ownershipPredicate(bodyCaptureSettings, principal))
        .limit(1);
      return rows[0] ? toValue(rows[0]) : null;
    },

    async upsertSettings(principal, value) {
      const rows = await db
        .insert(bodyCaptureSettings)
        .values(
          buildInsertValues(principal, {
            mode: value.mode,
            ...(value.retentionDays !== undefined ? { retentionDays: value.retentionDays } : {}),
          }) as typeof bodyCaptureSettings.$inferInsert,
        )
        .onConflictDoUpdate({
          target: bodyCaptureSettings.ownerUserId,
          set: {
            mode: value.mode,
            // Omission preserves the stored retention (explicit null = infinite).
            ...(value.retentionDays !== undefined ? { retentionDays: value.retentionDays } : {}),
            updatedAt: new Date(),
          },
        })
        .returning(SETTINGS_COLUMNS);
      const row = rows[0];
      if (!row) throw new Error('bodyCapture upsert returned no row');
      return toValue(row);
    },

    async captureContext(principal, agentId) {
      // One indexed read: settings ⟕ the agent's override (constant-false join
      // when no agent). Missing row ⇒ off (fail-closed, overrides inert).
      const rows = await db
        .select({
          mode: bodyCaptureSettings.mode,
          retentionDays: bodyCaptureSettings.retentionDays,
          epoch: bodyCaptureSettings.captureEpoch,
          override: agents.bodyCaptureOverride,
        })
        .from(bodyCaptureSettings)
        .leftJoin(
          agents,
          agentId === null
            ? sql`false`
            : and(eq(agents.id, agentId), ownershipPredicate(agents, principal)),
        )
        .where(ownershipPredicate(bodyCaptureSettings, principal))
        .limit(1);
      const row = rows[0];
      if (!row) return { mode: 'off', override: null, retentionDays: null, epoch: 0 };
      const override = row.override === 'always' || row.override === 'never' ? row.override : null;
      return {
        mode: asMode(row.mode),
        override,
        retentionDays: row.retentionDays,
        epoch: row.epoch,
      };
    },

    async incrementDropped(principal, by) {
      if (by <= 0) return;
      await db
        .insert(bodyCaptureSettings)
        .values(
          buildInsertValues(principal, {
            mode: 'off',
            droppedCount: by,
          }) as typeof bodyCaptureSettings.$inferInsert,
        )
        .onConflictDoUpdate({
          target: bodyCaptureSettings.ownerUserId,
          set: { droppedCount: sql`${bodyCaptureSettings.droppedCount} + ${by}` },
        });
    },

    async insertBodies(principal, items) {
      if (items.length === 0) return { inserted: 0, discarded: 0 };
      return db.transaction(async (tx) => {
        // THE serialization point (D9): every purge/delete takes this same lock.
        const settings = await tx
          .select({
            epoch: bodyCaptureSettings.captureEpoch,
            retentionDays: bodyCaptureSettings.retentionDays,
          })
          .from(bodyCaptureSettings)
          .where(ownershipPredicate(bodyCaptureSettings, principal))
          .limit(1)
          .for('update');
        const row = settings[0];
        if (!row) return { inserted: 0, discarded: items.length }; // no row = never armed
        const ids = [...new Set(items.map((i) => i.requestLogId))];
        // Parent validation (clink impl-Med-3): each body must attach to a log
        // row the PRINCIPAL owns — a foreign or missing parent is discarded
        // individually (never a batch-wide FK failure, never a cross-owner link).
        const ownedParents = new Set(
          (
            await tx
              .select({ id: requestLogs.id })
              .from(requestLogs)
              .where(and(ownershipPredicate(requestLogs, principal), inArray(requestLogs.id, ids)))
          ).map((r) => r.id),
        );
        const tombstoned = new Set(
          (
            await tx
              .select({ id: requestBodyTombstones.requestLogId })
              .from(requestBodyTombstones)
              .where(
                and(
                  ownershipPredicate(requestBodyTombstones, principal),
                  inArray(requestBodyTombstones.requestLogId, ids),
                ),
              )
          ).map((r) => r.id),
        );
        const cutoff =
          row.retentionDays === null
            ? null
            : new Date(Date.now() - row.retentionDays * 86_400_000);
        const live = items.filter(
          (i) =>
            i.epoch === row.epoch && // purged since capture → stale
            ownedParents.has(i.requestLogId) && // foreign/missing parent → discard
            !tombstoned.has(i.requestLogId) &&
            (cutoff === null || i.capturedAt >= cutoff), // late draft already expired
        );
        if (live.length > 0) {
          await tx
            .insert(requestBodies)
            .values(
              live.map(
                (i) =>
                  buildInsertValues(principal, {
                    requestLogId: i.requestLogId,
                    direction: i.direction,
                    contentEncrypted: i.contentEncrypted,
                    bytes: i.bytes,
                    truncated: i.truncated,
                    partial: i.partial,
                  }) as typeof requestBodies.$inferInsert,
              ),
            )
            .onConflictDoNothing(); // idempotent under writer retry
        }
        return { inserted: live.length, discarded: items.length - live.length };
      });
    },

    async listForRequest(principal, requestLogId) {
      return db
        .select({
          direction: sql<'request' | 'response'>`${requestBodies.direction}`,
          contentEncrypted: requestBodies.contentEncrypted,
          bytes: requestBodies.bytes,
          truncated: requestBodies.truncated,
          partial: requestBodies.partial,
          createdAt: requestBodies.createdAt,
        })
        .from(requestBodies)
        .where(
          and(
            ownershipPredicate(requestBodies, principal),
            eq(requestBodies.requestLogId, requestLogId),
          ),
        )
        .orderBy(requestBodies.direction);
    },

    async deleteForRequest(principal, requestLogId) {
      return db.transaction(async (tx) => {
        // Ownership first: a foreign/unknown id must not plant a tombstone.
        const owned = await tx
          .select({ id: requestLogs.id })
          .from(requestLogs)
          .where(and(ownershipPredicate(requestLogs, principal), eq(requestLogs.id, requestLogId)))
          .limit(1);
        if (!owned[0]) return false;
        // Same lock as the guarded insert (D9) — absent row still tombstones
        // (a queued draft may exist from an earlier armed period).
        await tx
          .select({ epoch: bodyCaptureSettings.captureEpoch })
          .from(bodyCaptureSettings)
          .where(ownershipPredicate(bodyCaptureSettings, principal))
          .limit(1)
          .for('update');
        await tx
          .delete(requestBodies)
          .where(
            and(
              ownershipPredicate(requestBodies, principal),
              eq(requestBodies.requestLogId, requestLogId),
            ),
          );
        await tx
          .insert(requestBodyTombstones)
          .values(
            buildInsertValues(principal, {
              requestLogId,
            }) as typeof requestBodyTombstones.$inferInsert,
          )
          .onConflictDoNothing();
        return true;
      });
    },

    async existsForRequests(principal, requestLogIds) {
      if (requestLogIds.length === 0) return new Set();
      const rows = await db
        .select({ id: requestBodies.requestLogId })
        .from(requestBodies)
        .where(
          and(
            ownershipPredicate(requestBodies, principal),
            inArray(requestBodies.requestLogId, [...requestLogIds]),
          ),
        )
        .groupBy(requestBodies.requestLogId);
      return new Set(rows.map((r) => r.id));
    },

    async purgeAll(principal) {
      return db.transaction(async (tx) => {
        const settings = await tx
          .select({ epoch: bodyCaptureSettings.captureEpoch })
          .from(bodyCaptureSettings)
          .where(ownershipPredicate(bodyCaptureSettings, principal))
          .limit(1)
          .for('update');
        if (!settings[0]) return 0;
        const deleted = await tx
          .delete(requestBodies)
          .where(ownershipPredicate(requestBodies, principal))
          .returning({ id: requestBodies.id });
        await tx
          .update(bodyCaptureSettings)
          .set({
            captureEpoch: sql`${bodyCaptureSettings.captureEpoch} + 1`, // revokes queued drafts
            lastPurgeAt: new Date(),
            lastPurgeCount: deleted.length,
            updatedAt: new Date(),
          })
          .where(ownershipPredicate(bodyCaptureSettings, principal));
        return deleted.length;
      });
    },

    async setAgentOverride(principal, agentId, override) {
      const rows = await db
        .update(agents)
        .set({ bodyCaptureOverride: override })
        .where(and(ownershipPredicate(agents, principal), eq(agents.id, agentId)))
        .returning({ id: agents.id });
      return rows.length > 0;
    },

    async purgeExpiredAllOwners() {
      // PRIVILEGED sweep (scheduler seam). LOCK ORDER (clink impl-High-1): the
      // owner settings rows are locked FIRST — deterministically ordered —
      // exactly like every other purge/delete/insert path, so the sweep can
      // never form a lock cycle with a concurrent manual purge. Every locked
      // (finite-retention) owner is stamped, zero-count included: lastPurgeAt
      // means "last sweep RAN", not "last sweep found something".
      return db.transaction(async (tx) => {
        const owners = await tx
          .select({
            owner: bodyCaptureSettings.ownerUserId,
            retentionDays: bodyCaptureSettings.retentionDays,
          })
          .from(bodyCaptureSettings)
          .where(sql`${bodyCaptureSettings.retentionDays} IS NOT NULL`)
          .orderBy(bodyCaptureSettings.ownerUserId)
          .for('update');
        if (owners.length === 0) return { owners: 0, purged: 0 };
        const deleted = await tx
          .delete(requestBodies)
          .where(
            inArray(
              requestBodies.id,
              tx
                .select({ id: requestBodies.id })
                .from(requestBodies)
                .innerJoin(
                  bodyCaptureSettings,
                  eq(bodyCaptureSettings.ownerUserId, requestBodies.ownerUserId),
                )
                .where(
                  and(
                    sql`${bodyCaptureSettings.retentionDays} IS NOT NULL`,
                    lt(
                      requestBodies.createdAt,
                      sql`now() - (${bodyCaptureSettings.retentionDays} * interval '1 day')`,
                    ),
                  ),
                ),
            ),
          )
          .returning({ owner: requestBodies.ownerUserId });
        const byOwner = new Map<string, number>();
        for (const r of deleted) byOwner.set(r.owner, (byOwner.get(r.owner) ?? 0) + 1);
        for (const o of owners) {
          await tx
            .update(bodyCaptureSettings)
            .set({
              lastPurgeAt: new Date(),
              lastPurgeCount: byOwner.get(o.owner) ?? 0,
              updatedAt: new Date(),
            })
            .where(eq(bodyCaptureSettings.ownerUserId, o.owner));
        }
        return { owners: owners.length, purged: deleted.length };
      });
    },
  };
}
