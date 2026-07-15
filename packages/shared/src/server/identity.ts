/** Identity-plane accessors (auth change #3). Deliberately SEPARATE from the
 * tenant `PersistencePort`: these are authentication/bootstrap concerns, not
 * ownership-scoped data. Semantic methods only — no query builder, no raw
 * handle — so exposing them does not widen the persistence attack surface. */

export interface AgentAuthRecord {
  id: string;
  ownerUserId: string;
  apiKeyHash: string;
  apiKeyPrefix: string;
}

export interface AgentAuthAccessor {
  /** Resolve an agent by its stored key prefix (O(1) lookup for the guard). */
  findByPrefix(prefix: string): Promise<AgentAuthRecord | null>;
  /** Stamp last_used_at; callers coalesce and never block on it. */
  touchLastUsed(agentId: string): Promise<void>;
}

export interface IdentityPort {
  /** Advisory-locked: if no admin exists, promote the earliest user. Returns the admin id (or null if there are no users yet). Idempotent. */
  ensureFirstAdmin(): Promise<string | null>;
  /** The current admin's id, or null. Used by localhost auto-login. */
  findAdminUserId(): Promise<string | null>;
  /** Idempotent default-tier provisioning for one user. */
  provisionDefaultTier(userId: string): Promise<void>;
  /** Advisory-locked: provision a default tier for EVERY user missing one — boot reconciliation of crashed post-commit hooks (including later users). */
  provisionMissingDefaultTiers(): Promise<number>;
  agentAuth: AgentAuthAccessor;
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
