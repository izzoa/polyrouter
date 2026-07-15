import type {
  agents,
  models,
  providers,
  routingRules,
  tiers,
  AgentRow,
  ModelRow,
  ProviderRow,
  RoutingEntryRow,
  RoutingRuleRow,
  TierRow,
} from './db/schema';
import type { Principal } from './tenancy';

/** Injection tokens for the persistence seam (spec §11.1 + the workspace
 * dependency matrix): the control-plane database module PROVIDES these; the
 * data-plane (#10/#11) and feature modules INJECT them — nobody outside the
 * database module ever sees a raw Pool/drizzle handle. */
export const PERSISTENCE_PORT = 'polyrouter:persistence-port';
export const PERSISTENCE_FACILITIES = 'polyrouter:persistence-facilities';
export const REDIS_CLIENT = 'polyrouter:redis-client';

type InsertInputOf<T extends { $inferInsert: unknown }> = Omit<
  T['$inferInsert'],
  'id' | 'ownerUserId' | 'orgId'
>;
type PatchOf<T extends { $inferInsert: unknown }> = Partial<InsertInputOf<T>>;

export type AgentInsertInput = InsertInputOf<typeof agents>;
export type ProviderInsertInput = InsertInputOf<typeof providers>;
export type TierInsertInput = InsertInputOf<typeof tiers>;
export type RoutingRuleInsertInput = InsertInputOf<typeof routingRules>;
export type AgentPatch = PatchOf<typeof agents>;
export type ProviderPatch = PatchOf<typeof providers>;
export type TierPatch = PatchOf<typeof tiers>;
export type RoutingRulePatch = PatchOf<typeof routingRules>;

/** Every method takes the principal; the ownership predicate is appended
 * centrally. There is NO unscoped by-id method. `id` and ownership columns
 * are immutable through this API (insert forces the owner from the
 * principal; update strips them at type level and runtime). */
export interface OwnedRepository<TRow, TInsertInput, TPatch> {
  findById(principal: Principal, id: string): Promise<TRow | null>;
  list(principal: Principal): Promise<TRow[]>;
  insert(principal: Principal, values: TInsertInput): Promise<TRow>;
  update(principal: Principal, id: string, patch: TPatch): Promise<TRow | null>;
  remove(principal: Principal, id: string): Promise<boolean>;
}

export type ModelInsertInput = Omit<(typeof models)['$inferInsert'], 'id' | 'providerId'>;
export type ModelPatch = Partial<ModelInsertInput>;

/** Models are owned THROUGH their provider — every accessor joins the parent
 * and applies the same ownership predicate, including at mutation time.
 * `providerId` is immutable (no repointing rows across tenants). */
export interface ModelAccessor {
  listForPrincipal(principal: Principal): Promise<ModelRow[]>;
  findById(principal: Principal, id: string): Promise<ModelRow | null>;
  /** Atomically validates the parent provider belongs to the principal; returns null (not-found) otherwise. */
  createForProvider(
    principal: Principal,
    providerId: string,
    values: ModelInsertInput,
  ): Promise<ModelRow | null>;
  update(principal: Principal, id: string, patch: ModelPatch): Promise<ModelRow | null>;
  remove(principal: Principal, id: string): Promise<boolean>;
}

/** Routing entries are owned through their tier; the linked model must also
 * be reachable by the principal. `tierId`/`modelId` are immutable — only the
 * position may change. */
export interface RoutingEntryAccessor {
  listForTier(principal: Principal, tierId: string): Promise<RoutingEntryRow[]>;
  /** Atomically validates tier AND model ownership; returns null (not-found) if either fails. */
  add(
    principal: Principal,
    entry: { tierId: string; modelId: string; position: number },
  ): Promise<RoutingEntryRow | null>;
  setPosition(principal: Principal, id: string, position: number): Promise<RoutingEntryRow | null>;
  remove(principal: Principal, id: string): Promise<boolean>;
}

/** Narrow identity-plane accessor for infrastructure that predates auth (#3's
 * first-admin race needs a user count inside an advisory lock). */
export interface UsersInfra {
  count(): Promise<number>;
}

/** The ONLY persistence surface exported outside the database module. By
 * construction it has no query/execute/Pool/drizzle member — unscoped SQL is
 * unwritable against it. */
export interface PersistencePort {
  agents: OwnedRepository<AgentRow, AgentInsertInput, AgentPatch>;
  providers: OwnedRepository<ProviderRow, ProviderInsertInput, ProviderPatch>;
  tiers: OwnedRepository<TierRow, TierInsertInput, TierPatch>;
  routingRules: OwnedRepository<RoutingRuleRow, RoutingRuleInsertInput, RoutingRulePatch>;
  models: ModelAccessor;
  routingEntries: RoutingEntryAccessor;
  users: UsersInfra;
  /** Idempotent, race-safe `default`-tier provisioning (spec §5); #3 calls this at user creation. */
  ensureDefaultTier(principal: Principal): Promise<TierRow>;
}

/** Privileged facilities (needed by #3's first-admin transaction). Callbacks
 * receive a TRANSACTION-BOUND PersistencePort — never a raw handle. */
export interface PersistenceFacilities {
  withTransaction<T>(fn: (tx: PersistencePort) => Promise<T>): Promise<T>;
  withAdvisoryLock<T>(lockKey: number, fn: (tx: PersistencePort) => Promise<T>): Promise<T>;
}
