/** Identity-plane accessors (auth change #3). Deliberately SEPARATE from the
 * tenant `PersistencePort`: these are authentication/bootstrap concerns, not
 * ownership-scoped data. Semantic methods only — no query builder, no raw
 * handle — so exposing them does not widen the persistence attack surface. */

export interface AgentAuthRecord {
  id: string;
  ownerUserId: string;
  apiKeyHash: string;
  apiKeyPrefix: string;
  /** Joined from the owner row: a disabled owner's keys must not authenticate
   * on /v1 (user-administration, invariant 7). Same lookup, no extra query. */
  ownerDisabled: boolean;
}

export interface AgentAuthAccessor {
  /** Resolve an agent by its stored key prefix (O(1) lookup for the guard). */
  findByPrefix(prefix: string): Promise<AgentAuthRecord | null>;
  /** Stamp last_used_at; callers coalesce and never block on it. */
  touchLastUsed(agentId: string): Promise<void>;
}

/** Whitelisted admin-facing user record (user-administration): identity fields
 * only — never password/session/token material. */
export interface AdminUserRecord {
  id: string;
  email: string;
  name: string;
  role: string | null;
  disabled: boolean;
  createdAt: Date;
}

export interface AdminInviteRecord {
  id: string;
  email: string;
  tokenPrefix: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

/** Admin user/invite/settings management (user-administration). Narrow,
 * semantic, records-only — no tenant data crosses this surface (invariant 5).
 * `refused` results encode the last-enabled-admin guard. */
export interface UserAdminAccessor {
  listUsers(): Promise<AdminUserRecord[]>;
  /** Grant/revoke admin. Refuses demoting the last enabled admin. */
  setRole(userId: string, role: 'admin' | null): Promise<'ok' | 'refused' | 'not_found'>;
  /** Disable also deletes the user's session rows in the SAME transaction (the
   * auth routes bypass the app guard, and re-enable must not resurrect a stale
   * session). Refuses disabling the last enabled admin. */
  setDisabled(userId: string, disabled: boolean): Promise<'ok' | 'refused' | 'not_found'>;
  /** Deletes the user; owned resources go via FK cascade. Refuses the last enabled admin. */
  deleteUser(userId: string): Promise<'ok' | 'refused' | 'not_found'>;
  createInvite(input: {
    email: string;
    tokenPrefix: string;
    tokenHash: string;
    createdBy: string;
    expiresAt: Date;
  }): Promise<AdminInviteRecord>;
  listInvites(): Promise<AdminInviteRecord[]>;
  revokeInvite(inviteId: string): Promise<boolean>;
  /** Atomic single-statement claim: consumes the invite iff unconsumed and
   * unexpired, returning its bound email (the account is created FOR that
   * email — binding is inherent). Concurrency-safe (single UPDATE…RETURNING). */
  claimInvite(tokenHash: string): Promise<{ email: string } | null>;
  /** Authoritative per-attempt read (multi-instance correctness — no cache). */
  getRegistrationMode(): Promise<RegistrationMode>;
  setRegistrationMode(mode: RegistrationMode): Promise<void>;
  /** Bootstrap admission: whether ANY user exists (gate engages after the first). */
  anyUserExists(): Promise<boolean>;
  /** Bootstrap single-winner: atomically claim the right to create the FIRST
   * user. Exactly one concurrent caller wins; losers are refused at admission.
   * A stale claim (crashed winner, still zero users) is stealable after a short
   * window, so a failed bootstrap self-heals without manual intervention. */
  claimBootstrap(): Promise<boolean>;
}

export interface IdentityPort {
  /** Advisory-locked: if no admin exists, promote the earliest user. Returns the admin id (or null if there are no users yet). Idempotent. */
  ensureFirstAdmin(): Promise<string | null>;
  /** The current ENABLED admin's id, or null. Used by localhost auto-login (a disabled admin must not be auto-logged-in). */
  findAdminUserId(): Promise<string | null>;
  /** Whether a specific user has the admin role AND is enabled (#8 gates global mutations). */
  isAdmin(userId: string): Promise<boolean>;
  /** The user's dashboard identity (#18 `GET /api/me`), or null if the row is gone. */
  getIdentity(
    userId: string,
  ): Promise<{ id: string; email: string; name: string; role: string | null } | null>;
  /** Whether the user is disabled (session-guard check): a MISSING row reads
   * as disabled — fail closed for a deleted user's lingering session. */
  isDisabled(userId: string): Promise<boolean>;
  /** Tri-state disabled flag: `null` when the row is not visible. Used by the
   * session-create hook, which runs INSIDE the signup transaction where the
   * brand-new user row is not yet committed — absence there means
   * "being created right now", not "deleted", so it must NOT fail closed. */
  disabledFlag(userId: string): Promise<boolean | null>;
  /** Idempotent default-tier provisioning for one user. */
  provisionDefaultTier(userId: string): Promise<void>;
  /** Advisory-locked: provision a default tier for EVERY user missing one — boot reconciliation of crashed post-commit hooks (including later users). */
  provisionMissingDefaultTiers(): Promise<number>;
  agentAuth: AgentAuthAccessor;
  userAdmin: UserAdminAccessor;
}

/** DI token for the identity port (control-plane provides it). */
export const IDENTITY_PORT = 'polyrouter:identity-port';

/** DI token for a LAZY factory that builds the opaque Better Auth drizzle
 * adapter over the database module's private pool (identity tables only). It's
 * a factory (not the adapter itself) so importing the ESM better-auth package
 * happens only when the auth plane actually calls it — non-auth modules that
 * import the database module never pull better-auth in. */
export const AUTH_ADAPTER_FACTORY = 'polyrouter:auth-adapter-factory';
export type AuthAdapterFactory = () => Promise<unknown>;

/** Advisory-lock key reserved for first-admin promotion / boot reconciliation. */
export const FIRST_ADMIN_LOCK = 918_273_645;

/** Advisory-lock key for the bootstrap single-winner claim (user-administration):
 * held transaction-scoped inside `user.create.before` so concurrent first signups
 * yield exactly one user. Distinct from FIRST_ADMIN_LOCK to avoid self-deadlock. */
export const BOOTSTRAP_LOCK = 918_273_646;

/** The instance-wide registration policy (user-administration). */
export const REGISTRATION_MODES = ['invite_only', 'open'] as const;
export type RegistrationMode = (typeof REGISTRATION_MODES)[number];
export const INSTANCE_SETTINGS_ID = 'singleton';
