import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  agents,
  BOOTSTRAP_LOCK,
  FIRST_ADMIN_LOCK,
  INSTANCE_SETTINGS_ID,
  instanceSettings,
  invites,
  REGISTRATION_MODES,
  sessions,
  tiers,
  users,
  type AdminInviteRecord,
  type AdminUserRecord,
  type AgentAuthRecord,
  type IdentityPort,
  type RegistrationMode,
} from '@polyrouter/shared/server';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Db } from './database.internal';

/** An admin is only *eligible* while enabled: the last-admin guard, auto-login,
 * and admin checks all use this predicate (a disabled admin counts for nothing). */
const enabledAdmin = and(eq(users.role, 'admin'), eq(users.disabled, false));

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
      const rows = await root.select({ id: users.id }).from(users).where(enabledAdmin).limit(1);
      return rows[0]?.id ?? null;
    },

    async isAdmin(userId: string): Promise<boolean> {
      const rows = await root
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, userId), enabledAdmin))
        .limit(1);
      return rows.length > 0;
    },

    async isDisabled(userId: string): Promise<boolean> {
      const rows = await root
        .select({ disabled: users.disabled })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      // A vanished row is treated as disabled — fail closed, never fail open.
      return rows[0]?.disabled ?? true;
    },

    async disabledFlag(userId: string): Promise<boolean | null> {
      const rows = await root
        .select({ disabled: users.disabled })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return rows[0]?.disabled ?? null;
    },

    async getIdentity(userId: string) {
      const rows = await root
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return rows[0] ?? null;
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
        // Owner joined in the SAME lookup: a disabled owner's key must not
        // authenticate on /v1, without adding a hot-path round-trip.
        const rows = await root
          .select({
            id: agents.id,
            ownerUserId: agents.ownerUserId,
            apiKeyHash: agents.apiKeyHash,
            apiKeyPrefix: agents.apiKeyPrefix,
            ownerDisabled: users.disabled,
          })
          .from(agents)
          .innerJoin(users, eq(users.id, agents.ownerUserId))
          .where(eq(agents.apiKeyPrefix, prefix))
          .limit(1);
        return rows[0] ?? null;
      },
      async touchLastUsed(agentId: string): Promise<void> {
        await root.update(agents).set({ lastUsedAt: new Date() }).where(eq(agents.id, agentId));
      },
    },

    userAdmin: {
      async listUsers(): Promise<AdminUserRecord[]> {
        return root
          .select({
            id: users.id,
            email: users.email,
            name: users.name,
            role: users.role,
            disabled: users.disabled,
            createdAt: users.createdAt,
          })
          .from(users)
          .orderBy(users.createdAt);
      },

      // Role/disable/delete run under the FIRST_ADMIN advisory lock so two
      // concurrent operations can't race each other past the last-enabled-admin
      // guard (e.g. two demotes that each see "another admin remains").
      async setRole(userId: string, role: 'admin' | null) {
        return root.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${FIRST_ADMIN_LOCK})`);
          const target = await tx
            .select({ id: users.id, role: users.role, disabled: users.disabled })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
          if (!target[0]) return 'not_found' as const;
          if (role === null && target[0].role === 'admin' && !target[0].disabled) {
            const others = await tx
              .select({ id: users.id })
              .from(users)
              .where(and(enabledAdmin, sql`${users.id} <> ${userId}`))
              .limit(1);
            if (!others[0]) return 'refused' as const;
          }
          await tx.update(users).set({ role }).where(eq(users.id, userId));
          return 'ok' as const;
        });
      },

      async setDisabled(userId: string, disabled: boolean) {
        return root.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${FIRST_ADMIN_LOCK})`);
          const target = await tx
            .select({ id: users.id, role: users.role, disabled: users.disabled })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
          if (!target[0]) return 'not_found' as const;
          if (disabled && target[0].role === 'admin' && !target[0].disabled) {
            const others = await tx
              .select({ id: users.id })
              .from(users)
              .where(and(enabledAdmin, sql`${users.id} <> ${userId}`))
              .limit(1);
            if (!others[0]) return 'refused' as const;
          }
          await tx.update(users).set({ disabled }).where(eq(users.id, userId));
          // Same transaction, on BOTH transitions: disabling revokes every
          // session so the auth routes (which bypass the app guard) can't
          // serve this user; re-enabling revokes too, so a session raced in
          // around the disable (signed in concurrently, inserted after the
          // delete) can never resurface — re-enabled users sign in fresh.
          await tx.delete(sessions).where(eq(sessions.userId, userId));
          return 'ok' as const;
        });
      },

      async deleteUser(userId: string) {
        return root.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${FIRST_ADMIN_LOCK})`);
          const target = await tx
            .select({ id: users.id, role: users.role, disabled: users.disabled })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
          if (!target[0]) return 'not_found' as const;
          if (target[0].role === 'admin' && !target[0].disabled) {
            const others = await tx
              .select({ id: users.id })
              .from(users)
              .where(and(enabledAdmin, sql`${users.id} <> ${userId}`))
              .limit(1);
            if (!others[0]) return 'refused' as const;
          }
          // Owned resources, sessions, accounts, and invites-created-by all
          // ride their onDelete: cascade FKs.
          await tx.delete(users).where(eq(users.id, userId));
          return 'ok' as const;
        });
      },

      async createInvite(input): Promise<AdminInviteRecord> {
        const rows = await root
          .insert(invites)
          .values({
            email: input.email,
            tokenPrefix: input.tokenPrefix,
            tokenHash: input.tokenHash,
            role: null,
            createdBy: input.createdBy,
            expiresAt: input.expiresAt,
          })
          .returning({
            id: invites.id,
            email: invites.email,
            tokenPrefix: invites.tokenPrefix,
            createdAt: invites.createdAt,
            expiresAt: invites.expiresAt,
            consumedAt: invites.consumedAt,
          });
        const row = rows[0];
        if (!row) throw new Error('invite insert returned no row');
        return row;
      },

      async listInvites(): Promise<AdminInviteRecord[]> {
        return root
          .select({
            id: invites.id,
            email: invites.email,
            tokenPrefix: invites.tokenPrefix,
            createdAt: invites.createdAt,
            expiresAt: invites.expiresAt,
            consumedAt: invites.consumedAt,
          })
          .from(invites)
          .orderBy(desc(invites.createdAt));
      },

      async revokeInvite(inviteId: string): Promise<boolean> {
        const rows = await root
          .delete(invites)
          .where(and(eq(invites.id, inviteId), isNull(invites.consumedAt)))
          .returning({ id: invites.id });
        return rows.length > 0;
      },

      async claimInvite(tokenHash: string): Promise<{ email: string } | null> {
        // Single conditional statement — concurrency-safe by construction: only
        // one caller can transition consumed_at NULL → now().
        const rows = await root
          .update(invites)
          .set({ consumedAt: new Date() })
          .where(
            and(
              eq(invites.tokenHash, tokenHash),
              isNull(invites.consumedAt),
              sql`${invites.expiresAt} > now()`,
            ),
          )
          .returning({ email: invites.email });
        return rows[0] ?? null;
      },

      async getRegistrationMode(): Promise<RegistrationMode> {
        // Authoritative per-attempt read — never cached (multi-instance safety).
        const rows = await root
          .select({ mode: instanceSettings.registrationMode })
          .from(instanceSettings)
          .where(eq(instanceSettings.id, INSTANCE_SETTINGS_ID))
          .limit(1);
        const mode = rows[0]?.mode;
        // A missing/invalid row fails CLOSED (invite_only), never open.
        return (REGISTRATION_MODES as readonly string[]).includes(mode ?? '')
          ? (mode as RegistrationMode)
          : 'invite_only';
      },

      async setRegistrationMode(mode: RegistrationMode): Promise<void> {
        await root
          .insert(instanceSettings)
          .values({ id: INSTANCE_SETTINGS_ID, registrationMode: mode, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: instanceSettings.id,
            set: { registrationMode: mode, updatedAt: new Date() },
          });
      },

      async anyUserExists(): Promise<boolean> {
        const rows = await root.select({ id: users.id }).from(users).limit(1);
        return rows.length > 0;
      },

      async claimBootstrap(): Promise<boolean> {
        // The first-signup race is decided one claimant at a time (BOOTSTRAP_LOCK)
        // by a guarded UPDATE: claim only while ZERO users exist and no live claim
        // is held. The 120s stale-steal exists ONLY to self-heal a claimant that
        // crashed mid-signup (claim held, zero users forever) — no successful
        // signup transaction lives anywhere near that long. Even the pathological
        // zombie (a stalled winner committing after its claim was stolen) is
        // bounded: ensureFirstAdmin is advisory-locked to exactly one admin, so
        // the stray is a plain member, visible and removable on the Users page.
        return root.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK})`);
          const rows = await tx.execute(sql`
            UPDATE ${instanceSettings}
               SET bootstrap_claimed_at = now()
             WHERE ${instanceSettings.id} = ${INSTANCE_SETTINGS_ID}
               AND NOT EXISTS (SELECT 1 FROM ${users})
               AND (${instanceSettings.bootstrapClaimedAt} IS NULL
                    OR ${instanceSettings.bootstrapClaimedAt} < now() - interval '120 seconds')
            RETURNING ${instanceSettings.id}
          `);
          return rows.rows.length > 0;
        });
      },
    },
  };
}
