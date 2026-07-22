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
  /** Clear all of a provider's models' user-set unit prices (owner-scoped),
   * returning the count cleared. Used when a provider's kind leaves custom/local
   * so a stale price can't be displayed for a now-catalog-priced provider. */
  clearPricingForProvider(principal: Principal, providerId: string): Promise<number>;
  /** Clear all of a provider's models' provider-listed DISPLAY estimates (`listed_*`,
   * owner-scoped), returning the count cleared. Used when a provider's base_url/protocol
   * changes so an estimate captured from the prior endpoint is not displayed
   * (add-provider-price-sync-and-edit). Never touches the billing user-price columns. */
  clearListedPricingForProvider(principal: Principal, providerId: string): Promise<number>;
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
export interface PricingRefreshRunInput {
  kind: 'litellm' | 'body' | 'bundled';
  added: number;
  skipped: number;
}

/** Catalog status metadata (add-pricing-refresh-ui): the panel's truth. */
export interface PricingStatusMeta {
  entryCount: number;
  newest: { source: string; validFrom: string; appliedAt: string } | null;
  lastRefresh: { at: string; added: number; skipped: number } | null;
}

export interface PricingCatalog {
  /** The version in effect at `at` (greatest `valid_from ≤ at`), or null. */
  priceAt(modelKey: string, at: Date): Promise<ModelPriceRow | null>;
  /** The versions in effect at `at` for each of `keys`, in ONE query (the effective
   * row per key). For the display effective-price path: resolve only the keys a model
   * set needs, never `N`×`priceAt` nor a full-catalog scan (add-provider-price-sync-and-edit). */
  priceAtMany(keys: readonly string[], at: Date): Promise<ModelPriceRow[]>;
  latest(modelKey: string): Promise<ModelPriceRow | null>;
  /** The current version per `model_key` (latest with `valid_from ≤ now`). */
  listLatest(now: Date): Promise<ModelPriceRow[]>;
  insertVersion(entry: ModelPriceInput): Promise<ModelPriceRow>;
  /** Append a COMPLETED refresh run — called inside the same advisory-lock
   * transaction as the version apply (add-pricing-refresh-ui). */
  insertRefreshRun(input: PricingRefreshRunInput): Promise<void>;
  /** Status metadata: current-key count, newest applied version, newest
   * litellm-kind run. */
  statusMeta(now: Date): Promise<PricingStatusMeta>;
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
  /** USD: the portion of `spend` whose components (either ledger) were priced
   * `native_family` — component-only arithmetic, same µ$ rounding
   * (add-native-price-fallback). Zero when none. */
  nativeFamilySpend: number;
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
  /** True when the served row OR any per-attempt row was priced `native_family`
   * (add-native-price-fallback) — an estimate in the combined total is never
   * invisible. */
  priceEstimated: boolean;
};

export interface AnalyticsRequestsPage {
  rows: AnalyticsRequestRow[];
  nextCursor: string | null;
}

/** Owner-scoped analytics aggregation reads (#17). Every method is scoped to the
 * principal (invariant 5) — no unscoped-by-owner fetch, no cross-tenant path. */
/** Auto-performance aggregation over the decision-telemetry columns
 * (add-auto-performance-view). Counts are DISJOINT partitions; savings math
 * happens in the accessor as per-row integer micro-dollars against the
 * caller-resolved counterfactual rates (null = basis unresolvable → no query). */
export interface AutoCounterfactualRates {
  inputPer1m: number;
  outputPer1m: number;
  cacheReadPer1m: number | null;
  cacheWritePer1m: number | null;
}
export interface AutoSavingsTotals {
  /** Monetary totals are null (unknown, never $0) when zero rows were costable
   * — coverage (`rows`/`uncostedRows`) is still reported (r3-High-2). */
  rows: number;
  uncostedRows: number;
  netMicros: number | null;
  grossMicros: number | null;
  excessMicros: number | null;
}
export interface AutoPerformanceData {
  evaluated: number;
  bands: {
    high: { requests: number; declared: number; unroutable: number };
    low: { requests: number; declared: number; unroutable: number };
    ambiguous: { requests: number };
  };
  cascade: {
    requests: number;
    qualityPassed: number;
    qualityUnknown: number;
    failedOrCancelled: number;
    escalated: number;
  };
  /** L2 semantic slice (add-semantic-dashboard D4). `evaluated` = `semantic_band`
   * non-null; `routed` = `decision_layer='semantic'` by band; `outcomes` = the
   * routed terminal-status split (DISJOINT + EXHAUSTIVE — sums to the routed
   * total); `source` = bundled/learned over evaluated. All zero on legacy rows
   * (semantic columns null), so the view stays invisible until L2 runs. */
  semantic: {
    evaluated: number;
    routed: { high: number; low: number };
    outcomes: { success: number; fallback: number; error: number; cancelled: number };
    source: { bundled: number; learned: number };
  };
  fallthrough: number;
  series: { bucket: string; high: number; low: number; ambiguous: number }[];
  /** RANGE-INDEPENDENT: the tenant's earliest banded row ever (ISO), or null. */
  telemetrySince: string | null;
  /** Present only when counterfactual rates were supplied. */
  savings: AutoSavingsTotals | null;
}

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
  autoPerformance(
    principal: Principal,
    range: AnalyticsRange,
    bucket: AnalyticsBucket,
    counterfactual: AutoCounterfactualRates | null,
  ): Promise<AutoPerformanceData>;
  /** Edge-zone calibration evidence (add-auto-threshold-calibration): counts
   * over the tenant's quality-DECIDED, threshold-source, CURRENT-EPOCH
   * ambiguous cascade rows in the window. Fail-closed populations — a pass is
   * served+scored+non-escalated with a null escalation source; a failure is
   * `escalation_source = 'quality_gate'`; everything else is invisible. */
  calibrationStats(
    principal: Principal,
    range: AnalyticsRange,
    args: { high: number; low: number; edgeWidth: number; epoch: number },
  ): Promise<CalibrationEdgeStats>;
}

export interface CalibrationEdgeStats {
  highEdge: { samples: number; failures: number };
  lowEdge: { samples: number; failures: number };
}

/** Per-tenant automatic-routing layer preference (#20) + threshold
 * calibration (add-auto-threshold-calibration). Absent = inherit the
 * instance capability. The calibrated quad travels together (all null or
 * all set); `calibrationEpoch` bumps on every threshold event and is
 * stamped onto evaluated request rows at decision time. */
export interface RoutingSettingsValue {
  structuralEnabled: boolean;
  cascadeEnabled: boolean;
  /** L2 preference (add-semantic-routing); semantic⇒structural holds. */
  semanticEnabled: boolean;
  /** L2 learning preference (add-semantic-learning); learning⇒semantic holds.
   * `epoch` = revocation counter, `generation` = active learned-state version. */
  semanticLearningEnabled: boolean;
  semanticLearningEpoch: number;
  semanticLearningGeneration: number;
  calibrationEnabled: boolean;
  calibratedHigh: number | null;
  calibratedLow: number | null;
  calibratedAnchorHigh: number | null;
  calibratedAnchorLow: number | null;
  calibrationEpoch: number;
}

/** The upsert input: layer flags required (the existing PUT contract);
 * `calibrationEnabled` optional — OMISSION PRESERVES the stored flag, and
 * the upsert NEVER touches the calibrated quad or epoch. */
export interface RoutingSettingsUpsert {
  structuralEnabled: boolean;
  cascadeEnabled: boolean;
  /** Optional (pre-change clients omit it): omission PRESERVES the stored
   * value — except `structuralEnabled:false`, which also clears semantic in
   * the same atomic upsert (dependency-down; add-semantic-routing D7). */
  semanticEnabled?: boolean;
  /** Optional (pre-change clients omit it): omission PRESERVES the stored
   * value — except when `semanticEnabled` resolves false, which also clears
   * learning in the same atomic upsert (dependency-down; add-semantic-learning). */
  semanticLearningEnabled?: boolean;
  calibrationEnabled?: boolean;
}

/** The calibrated quad as written by the calibrator (all four together). */
export interface CalibratedQuad {
  high: number;
  low: number;
  anchorHigh: number;
  anchorLow: number;
}

/** The observed state a conditional calibration write is predicated on —
 * any mismatch (concurrent disable/revert/rebase) skips the write. */
export interface CalibrationExpectedState {
  enabled: boolean | null; // null = don't require the flag (revert/rebase)
  high: number | null;
  low: number | null;
  anchorHigh: number | null;
  anchorLow: number | null;
  epoch: number;
}

/** A tenant surfaced by the calibration sweeps. */
export interface CalibrationSweepTenant {
  ownerUserId: string;
  value: RoutingSettingsValue;
}

export interface ThresholdCalibrationEventInput {
  trigger: 'calibrator' | 'revert' | 'rebase';
  oldHigh: number;
  oldLow: number;
  newHigh: number;
  newLow: number;
  anchorHigh: number;
  anchorLow: number;
  windowFrom?: Date | null;
  windowTo?: Date | null;
  edge?: 'high' | 'low' | null;
  edgeSamples?: number | null;
  edgeFailures?: number | null;
  reason: string;
}

export interface ThresholdCalibrationEventRowView {
  id: string;
  trigger: string;
  oldHigh: number;
  oldLow: number;
  newHigh: number;
  newLow: number;
  anchorHigh: number;
  anchorLow: number;
  windowFrom: string | null;
  windowTo: string | null;
  edge: string | null;
  edgeSamples: number | null;
  edgeFailures: number | null;
  reason: string;
  createdAt: string;
}

/** Owner-scoped read/upsert of the tenant's auto-layer preference (one row per
 * owner) + the calibration write/sweep surface. `get` returns null when the
 * tenant has no preference. `setCalibrated` is the CONDITIONAL row-locked
 * write (calibrator move / revert / rebase): it applies `quad` (or clears on
 * null), bumps the epoch, and returns false — writing nothing — when the row
 * no longer matches `expected`. The two list methods are system-scope sweep
 * enumerations (trusted scheduler); every per-tenant statement elsewhere is
 * ownership-predicated. */
export interface RoutingSettingsAccessor {
  get(principal: Principal): Promise<RoutingSettingsValue | null>;
  upsert(principal: Principal, value: RoutingSettingsUpsert): Promise<RoutingSettingsValue>;
  setCalibrated(
    principal: Principal,
    quad: CalibratedQuad | null,
    expected: CalibrationExpectedState,
    events:
      | ThresholdCalibrationEventInput
      | ThresholdCalibrationEventInput[]
      | ((
          observed: RoutingSettingsValue,
        ) => ThresholdCalibrationEventInput | ThresholdCalibrationEventInput[]),
  ): Promise<boolean>;
  /** The USER-WINS clear (revert, r3-Med-2): one transaction that locks the
   * row and clears WHATEVER pair is present — no pre-read expected state, so
   * a calibrator move landing mid-flight cannot make the user's revert a
   * silent no-op. Returns false (no event) only when no pair existed. */
  clearCalibrated(
    principal: Principal,
    eventOf: (observed: RoutingSettingsValue) => ThresholdCalibrationEventInput,
  ): Promise<boolean>;
  listCalibrationEnabled(): Promise<CalibrationSweepTenant[]>;
  listWithCalibratedPair(): Promise<CalibrationSweepTenant[]>;
  /** The learning sweep's APPLY (add-semantic-learning D5): in ONE row-locked
   * transaction, CAS the tenant's `(epoch, generation)` against `expected`, insert
   * the audit under its unique `occurrenceId`, and advance `generation` to
   * `event.generation` (= expected.generation + 1). Idempotent — see
   * {@link SemanticLearningApplyResult}. */
  recordLearningApply(
    principal: Principal,
    expected: SemanticLearningExpectedState,
    event: SemanticLearningEventInput,
  ): Promise<SemanticLearningApplyResult>;
  /** Audit a `discard_revision` (D9): insert the scalars-only row idempotently on
   * its `occurrenceId`; NO generation/epoch change. Returns false when this
   * occurrence was already audited. */
  recordLearningDiscard(principal: Principal, event: SemanticLearningEventInput): Promise<boolean>;
  /** System-scope sweep enumeration (trusted scheduler) — the learning-enabled tenants. */
  listSemanticLearningEnabled(): Promise<SemanticLearningSweepTenant[]>;
  /** User revert (D4/5.2): in one row-locked transaction bump the revocation
   * epoch (E→E+1), reset the generation to 0, and audit `revert`. Postgres-FIRST:
   * the bump makes any in-flight sweep's CAS fail and every reader's `readActive`
   * gate out the old epoch, so the Redis delete that follows is best-effort. Returns
   * the NEW `(epoch, generation)` coordinates, or null when the tenant has no row. */
  revertLearning(
    principal: Principal,
    reason: string,
  ): Promise<{ epoch: number; generation: number } | null>;
}

/** Owner-scoped calibration history reads (the writes ride `setCalibrated`'s
 * transaction). */
export interface CalibrationEventsAccessor {
  list(principal: Principal, limit: number): Promise<ThresholdCalibrationEventRowView[]>;
}

/* ---- semantic learning (add-semantic-learning: the sweep's Postgres half) ---- */

/** The `(epoch, generation)` an apply is predicated on (D5 CAS). */
export interface SemanticLearningExpectedState {
  epoch: number;
  generation: number;
}

/** A scalars-only sweep audit row input (invariant 8 — never a vector). Drift /
 * similarity are cosine scalars in [0, 2]; `occurrenceId` is the deterministic
 * idempotency key. For an `apply`, `epoch`/`generation` are the RESULTING coords
 * (generation = G+1); for a `discard_revision`, the unchanged current coords. */
export interface SemanticLearningEventInput {
  occurrenceId: string;
  trigger: 'apply' | 'discard_revision' | 'revert';
  epoch: number;
  generation: number;
  highSamples?: number;
  lowSamples?: number;
  highDrift?: number | null;
  lowDrift?: number | null;
  highSimilarity?: number | null;
  lowSimilarity?: number | null;
  reason: string;
}

/** A tenant surfaced by the learning sweep. */
export interface SemanticLearningSweepTenant {
  ownerUserId: string;
  value: RoutingSettingsValue;
}

/** `applied` = CAS held, generation bumped, audited. `duplicate` = this
 * occurrence already committed (crash-after-commit retry) — the caller promotes.
 * `stale` = a concurrent revert/apply moved the coordinates — the caller skips. */
export type SemanticLearningApplyResult = 'applied' | 'duplicate' | 'stale';

export interface SemanticLearningEventRowView {
  id: string;
  occurrenceId: string;
  trigger: string;
  epoch: number;
  generation: number;
  highSamples: number;
  lowSamples: number;
  highDrift: number | null;
  lowDrift: number | null;
  highSimilarity: number | null;
  lowSimilarity: number | null;
  reason: string;
  createdAt: string;
}

/** Owner-scoped learning history reads (the writes ride the sweep's transaction). */
export interface SemanticLearningEventsAccessor {
  list(principal: Principal, limit: number): Promise<SemanticLearningEventRowView[]>;
  /** The newest `apply` row (or null) — a TARGETED query (not a top-N scan) so a
   * flurry of discard/revert rows can never hide the last apply from the sweep's
   * crash-recovery + cooldown checks (clink impl High-1/Med-6). */
  lastApply(principal: Principal): Promise<SemanticLearningEventRowView | null>;
}

/* ---- body-capture (add-body-capture, invariant 8's opt-in door) ---- */

export type BodyCaptureMode = 'off' | 'errors_only' | 'all';
export type BodyCaptureOverride = 'always' | 'never';

export interface BodyCaptureSettingsValue {
  mode: BodyCaptureMode;
  retentionDays: number | null;
  captureEpoch: number;
  droppedCount: number;
  lastPurgeAt: Date | null;
  lastPurgeCount: number;
}

export interface BodyCaptureSettingsUpsert {
  mode: BodyCaptureMode;
  /** Omitted preserves the stored value; explicit null = infinite (the caller
   * enforces the keep-forever consent guard before it reaches here). */
  retentionDays?: number | null;
}

/** The per-request capture context the proxy loads at prepare time — ONE query
 * (settings ⟕ agent override). `epoch` is echoed into drafts for revocation. */
export interface BodyCaptureContext {
  mode: BodyCaptureMode;
  override: BodyCaptureOverride | null;
  retentionDays: number | null;
  epoch: number;
}

/** CIPHERTEXT insert item — the writer encrypts before it reaches the port.
 * `epoch`/`capturedAt` feed the guarded insert's revocation checks. */
export interface RequestBodyInsertItem {
  requestLogId: string;
  direction: 'request' | 'response';
  contentEncrypted: string;
  bytes: number;
  truncated: boolean;
  partial: boolean;
  epoch: number;
  capturedAt: Date;
}

export interface RequestBodyView {
  direction: 'request' | 'response';
  contentEncrypted: string;
  bytes: number;
  truncated: boolean;
  partial: boolean;
  createdAt: Date;
}

export interface BodyCaptureAccessor {
  /** Null = no row = mode 'off' (fail-closed). */
  getSettings(principal: Principal): Promise<BodyCaptureSettingsValue | null>;
  upsertSettings(
    principal: Principal,
    value: BodyCaptureSettingsUpsert,
  ): Promise<BodyCaptureSettingsValue>;
  /** One query: settings row + the agent's override. Missing row ⇒ mode off. */
  captureContext(principal: Principal, agentId: string | null): Promise<BodyCaptureContext>;
  /** Batched drop accounting from the writer (upserts the row at 'off'). */
  incrementDropped(principal: Principal, by: number): Promise<void>;
  /** GUARDED insert (D9): one transaction locks the owner's settings row FOR
   * UPDATE, re-reads epoch/tombstones/retention post-lock, discards stale,
   * tombstoned, or already-expired items (counted), inserts the rest. A missing
   * settings row discards everything (fail-closed). */
  insertBodies(
    principal: Principal,
    items: readonly RequestBodyInsertItem[],
  ): Promise<{ inserted: number; discarded: number }>;
  listForRequest(principal: Principal, requestLogId: string): Promise<RequestBodyView[]>;
  /** Delete + tombstone under the same owner lock; false when nothing existed
   * AND no tombstone was needed (unknown/foreign id). */
  deleteForRequest(principal: Principal, requestLogId: string): Promise<boolean>;
  /** Batched existence for the listing's `hasBodies` (no N+1). */
  existsForRequests(principal: Principal, requestLogIds: readonly string[]): Promise<Set<string>>;
  /** Purge-all / disable-with-purge: bumps the epoch and deletes every body,
   * stamping last_purge — one locked transaction. Returns the purged count. */
  purgeAll(principal: Principal): Promise<number>;
  setAgentOverride(
    principal: Principal,
    agentId: string,
    override: BodyCaptureOverride | null,
  ): Promise<boolean>;
  /** PRIVILEGED daily sweep (no principal — the scheduler's seam): one
   * settings⋈bodies pass deleting rows older than each owner's retention
   * (infinite skipped), stamping each swept owner's last_purge. */
  purgeExpiredAllOwners(): Promise<{ owners: number; purged: number }>;
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
  calibrationEvents: CalibrationEventsAccessor;
  semanticLearningEvents: SemanticLearningEventsAccessor;
  bodyCapture: BodyCaptureAccessor;
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
  /** `opts.lockTimeoutMs` bounds the lock WAIT via a transaction-local `lock_timeout`
   * (add-subscription-oauth): exceeding it aborts the transaction with an
   * `AdvisoryLockTimeoutError`, freeing the pooled connection — no detached waiter can
   * outlive its caller. Omitted = today's unbounded wait (the pricing seed path). */
  withAdvisoryLock<T>(
    lockKey: number,
    fn: (tx: PersistencePort) => Promise<T>,
    opts?: { lockTimeoutMs?: number },
  ): Promise<T>;
}
