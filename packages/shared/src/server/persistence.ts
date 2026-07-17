import type {
  agents,
  budgets,
  models,
  notificationChannels,
  providers,
  requestAttempts,
  requestLogs,
  routingRules,
  tiers,
  AgentRow,
  BudgetRow,
  ModelPriceRow,
  ModelRow,
  NotificationChannelRow,
  ProviderRow,
  RequestAttemptRow,
  RequestLogRow,
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
export type NotificationChannelInsertInput = InsertInputOf<typeof notificationChannels>;
export type BudgetInsertInput = InsertInputOf<typeof budgets>;
export type AgentPatch = PatchOf<typeof agents>;
export type ProviderPatch = PatchOf<typeof providers>;
export type TierPatch = PatchOf<typeof tiers>;
export type RoutingRulePatch = PatchOf<typeof routingRules>;
export type NotificationChannelPatch = PatchOf<typeof notificationChannels>;
export type BudgetPatch = PatchOf<typeof budgets>;

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
  /** Atomic catalog upsert keyed on `(provider_id, external_model_id)`
   * (#7's `sync-models`): insert-or-update `display_name`/`last_synced_at` in one
   * statement so concurrent syncs and duplicate ids can't violate the unique
   * index. Validates parent ownership in-statement; returns null if unowned. */
  upsertForProvider(
    principal: Principal,
    providerId: string,
    values: ModelInsertInput,
  ): Promise<ModelRow | null>;
  update(principal: Principal, id: string, patch: ModelPatch): Promise<ModelRow | null>;
  remove(principal: Principal, id: string): Promise<boolean>;
}

/** Outcome of an atomic chain replacement (#9). Distinguishes the two ownership
 * failures so the service maps them to 404 vs 422 without leaking which tenant
 * owns what. `unknown_models` lists exactly the ids that are not owned models. */
export type ReplaceEntriesResult =
  | { status: 'ok'; entries: RoutingEntryRow[] }
  | { status: 'tier_not_found' }
  | { status: 'unknown_models'; modelIds: string[] };

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
  /** Atomically REPLACE a tier's whole ordered chain with `orderedModelIds`
   * (positions `0..N-1`). Locks the tier row (`FOR UPDATE`) so concurrent
   * replacements serialize instead of racing the non-deferrable
   * `UNIQUE(tier_id,position)`. All-or-nothing: an unowned tier or any unowned
   * model aborts with no write. Cap/dedup are the caller's precondition; the
   * DB CHECK/UNIQUE remain the backstop. */
  replaceForTier(
    principal: Principal,
    tierId: string,
    orderedModelIds: string[],
  ): Promise<ReplaceEntriesResult>;
}

/** Narrow identity-plane accessor for infrastructure that predates auth (#3's
 * first-admin race needs a user count inside an advisory lock). */
export interface UsersInfra {
  count(): Promise<number>;
}

/** A catalog price version ready to append. */
export type ModelPriceInput = {
  modelKey: string;
  inputPricePer1m: number;
  outputPricePer1m: number;
  cacheReadPricePer1m?: number | null;
  cacheWritePricePer1m?: number | null;
  contextWindow?: number | null;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  isFree?: boolean;
  source: string;
  validFrom: Date;
};

/** The GLOBAL (non-tenant) pricing catalog (#8, §7.7). Append-only reference
 * data — no owner, no update/delete. The single write path is #8's locked
 * `applyVersions`, which reads `latest` and appends via `insertVersion`. */
export interface PricingCatalog {
  /** The version in effect at `at` (greatest `valid_from ≤ at`), or null. */
  priceAt(modelKey: string, at: Date): Promise<ModelPriceRow | null>;
  latest(modelKey: string): Promise<ModelPriceRow | null>;
  /** The current version per `model_key` (latest with `valid_from ≤ now`). */
  listLatest(now: Date): Promise<ModelPriceRow[]>;
  insertVersion(entry: ModelPriceInput): Promise<ModelPriceRow>;
}

/** A request-log row ready to insert. `id` is PRE-ALLOCATED by the recorder (so
 * a retry is idempotent); the owner is NOT here — it is forced from the
 * principal at `insertMany`. */
export type RequestLogInsertInput = Omit<
  (typeof requestLogs)['$inferInsert'],
  'ownerUserId' | 'orgId'
> & { id: string };

/** Immutable request-log audit records (#11). Written in batches per principal
 * (owner forced from the principal — not caller input), inserted idempotently
 * (`ON CONFLICT (id) DO NOTHING`). Reads are ownership-scoped (invariant 5). */
export interface RequestLogAccessor {
  insertMany(principal: Principal, rows: RequestLogInsertInput[]): Promise<void>;
  list(principal: Principal): Promise<RequestLogRow[]>;
  findById(principal: Principal, id: string): Promise<RequestLogRow | null>;
}

/** A request-attempt ledger row ready to insert (id pre-allocated; owner forced
 * from the principal at `insertMany`). Records an ADDITIONAL billable call for a
 * request (#14 cascade) at its own immutable snapshot price. */
export type RequestAttemptInsertInput = Omit<
  (typeof requestAttempts)['$inferInsert'],
  'ownerUserId' | 'orgId'
> & { id: string };

/** Per-billable-call cost ledger (#14). Written in batches per principal (owner
 * forced from the principal), idempotent (`ON CONFLICT (id) DO NOTHING`); reads
 * are ownership-scoped (invariant 5). */
export interface RequestAttemptAccessor {
  insertMany(principal: Principal, rows: RequestAttemptInsertInput[]): Promise<void>;
  listForRequest(principal: Principal, requestLogId: string): Promise<RequestAttemptRow[]>;
}

/** Owner-scoped analytics reads over the request-log ledgers (#17, spec §9).
 * Aggregation only — no writes, no cross-owner path. Spend sums BOTH the served
 * `request_log.cost` and the cascade `request_attempt.cost`, with the same
 * per-row µ$ rounding the budget counters use (#16), so dashboard spend
 * reconciles with budgets (invariant 4). */
export interface AnalyticsRange {
  from: Date;
  /** Exclusive upper bound (half-open `[from, to)`). */
  to: Date;
}

export type AnalyticsBucket = 'hour' | 'day' | 'week' | 'month';
export type AnalyticsDimension = 'model' | 'provider' | 'agent' | 'tier';

export interface AnalyticsSummary {
  /** USD, both ledgers, µ$-rounded (matches budgets). */
  spend: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  successCount: number;
  fallbackCount: number;
  errorCount: number;
  escalatedCount: number;
  estimatedCount: number;
  /** Served-request classification by served cost: 0 / >0 / null. */
  freeRequests: number;
  paidRequests: number;
  unpricedRequests: number;
}

export interface AnalyticsTimeseriesPoint {
  /** UTC-aligned bucket start. */
  bucket: Date;
  requests: number;
  spend: number;
  inputTokens: number;
  outputTokens: number;
  errorCount: number;
  fallbackCount: number;
  escalatedCount: number;
}

export interface AnalyticsBreakdownRow {
  /** Dimension id / tier key (`''` when the dimension is null on the row). */
  key: string;
  /** Owner-scoped human label, null if the catalog row was deleted. */
  label: string | null;
  spend: number;
  requests: number;
}

export interface AnalyticsRequestsCursor {
  /** Full-precision `created_at::text` (µs), NOT a millisecond-truncated JS Date —
   * so a batch of rows sharing one `now()` timestamp pages exactly once (E3). */
  createdAt: string;
  id: string;
}

export interface AnalyticsRequestsQuery {
  from: Date;
  to: Date;
  limit: number;
  cursor?: AnalyticsRequestsCursor;
  status?: string;
  /** Match ANY of these decision layers (the dashboard's multi-value chips). */
  decisionLayers?: string[];
  escalated?: boolean;
}

/** A request-log row enriched for the dashboard listing: owner-scoped labels
 * (id fallback when a catalog row is gone) + this request's attempt cost in µ$
 * so the UI can show `total = round(cost×1e6) + attemptCostMicros`. */
export type AnalyticsRequestRow = RequestLogRow & {
  modelLabel: string | null;
  providerLabel: string | null;
  agentLabel: string | null;
  attemptCostMicros: number;
};

export interface AnalyticsRequestsPage {
  rows: AnalyticsRequestRow[];
  nextCursor: string | null;
}

/** Owner-scoped analytics aggregation reads (#17). Every method is scoped to the
 * principal (invariant 5) — no unscoped-by-owner fetch, no cross-tenant path. */
export interface AnalyticsAccessor {
  summary(principal: Principal, range: AnalyticsRange): Promise<AnalyticsSummary>;
  timeseries(
    principal: Principal,
    range: AnalyticsRange,
    bucket: AnalyticsBucket,
  ): Promise<AnalyticsTimeseriesPoint[]>;
  breakdown(
    principal: Principal,
    range: AnalyticsRange,
    dimension: AnalyticsDimension,
    limit: number,
  ): Promise<AnalyticsBreakdownRow[]>;
  listRequests(principal: Principal, query: AnalyticsRequestsQuery): Promise<AnalyticsRequestsPage>;
}

/** Per-tenant automatic-routing layer preference (#20). Absent = inherit the
 * instance capability. */
export interface RoutingSettingsValue {
  structuralEnabled: boolean;
  cascadeEnabled: boolean;
}

/** Owner-scoped read/upsert of the tenant's auto-layer preference (one row per
 * owner). `get` returns null when the tenant has no preference. */
export interface RoutingSettingsAccessor {
  get(principal: Principal): Promise<RoutingSettingsValue | null>;
  upsert(principal: Principal, value: RoutingSettingsValue): Promise<RoutingSettingsValue>;
}

/** The ONLY persistence surface exported outside the database module. By
 * construction it has no query/execute/Pool/drizzle member — unscoped SQL is
 * unwritable against it. */
export interface PersistencePort {
  agents: OwnedRepository<AgentRow, AgentInsertInput, AgentPatch>;
  providers: OwnedRepository<ProviderRow, ProviderInsertInput, ProviderPatch>;
  tiers: OwnedRepository<TierRow, TierInsertInput, TierPatch>;
  routingRules: OwnedRepository<RoutingRuleRow, RoutingRuleInsertInput, RoutingRulePatch>;
  notificationChannels: OwnedRepository<
    NotificationChannelRow,
    NotificationChannelInsertInput,
    NotificationChannelPatch
  >;
  budgets: OwnedRepository<BudgetRow, BudgetInsertInput, BudgetPatch>;
  models: ModelAccessor;
  routingEntries: RoutingEntryAccessor;
  requestLogs: RequestLogAccessor;
  requestAttempts: RequestAttemptAccessor;
  analytics: AnalyticsAccessor;
  routingSettings: RoutingSettingsAccessor;
  users: UsersInfra;
  /** Global pricing catalog (#8) — non-owned, append-only. */
  pricing: PricingCatalog;
  /** Idempotent, race-safe `default`-tier provisioning (spec §5); #3 calls this at user creation. */
  ensureDefaultTier(principal: Principal): Promise<TierRow>;
}

/** Privileged facilities (needed by #3's first-admin transaction). Callbacks
 * receive a TRANSACTION-BOUND PersistencePort — never a raw handle. */
export interface PersistenceFacilities {
  withTransaction<T>(fn: (tx: PersistencePort) => Promise<T>): Promise<T>;
  withAdvisoryLock<T>(lockKey: number, fn: (tx: PersistencePort) => Promise<T>): Promise<T>;
}
