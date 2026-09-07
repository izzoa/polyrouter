import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { AttemptFailureEntry } from '../../attempt-failures';
import {
  BATCH_ENDPOINTS,
  BATCH_JOB_ERROR_KINDS,
  BATCH_JOB_STATUSES,
  BATCH_JOB_TERMINAL_STATUSES,
} from '../../batch-jobs';

/** Spec §5 identity/config core. Feature-owned tables (ModelPrice, RequestLog,
 * NotificationChannel, Limit) land with their owning changes, not here. */

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();

/** Better Auth-compatible core columns (table name `user`, text ids) so the
 * auth change points its Drizzle adapter here without a rename migration.
 * `role` is server-owned (Better Auth `additionalFields` input:false; first
 * user = admin, #3). */
export const users = pgTable(
  'user',
  {
    id: id(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').default(false).notNull(),
    image: text('image'),
    role: text('role'),
    // Admin-managed lockout (user-administration): a disabled user is denied on
    // BOTH planes (session + agent-key) and cannot mint a new session.
    disabled: boolean('disabled').default(false).notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('user_email_unique').on(t.email)],
);

/** Single-use, hashed, expiring account invites (user-administration). The raw
 * token is never stored — only its prefix + HMAC-style hash, like agent keys. */
export const invites = pgTable(
  'invite',
  {
    id: id(),
    email: text('email').notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    // Invited role is always non-admin; kept explicit for a future admin-invite.
    role: text('role'),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('invite_token_prefix_unique').on(t.tokenPrefix),
    index('invite_email_idx').on(t.email),
  ],
);

/** Instance-wide, admin-editable runtime settings — a single seeded row
 * (id='singleton'). Holds the registration policy (user-administration).
 * Admission reads this row authoritatively per signup attempt (multi-instance
 * correctness — a per-node cache could leak signups after a close). */
export const instanceSettings = pgTable(
  'instance_settings',
  {
    id: text('id').primaryKey(),
    registrationMode: text('registration_mode').notNull(),
    /** Bootstrap single-winner marker (user-administration): the first-signup
     * race is decided by ONE atomic claim on this column — losers are refused
     * at admission; a stale claim (crashed winner, still zero users) is
     * stealable after a short window, so a failed bootstrap self-heals. */
    bootstrapClaimedAt: timestamp('bootstrap_claimed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check(
      'instance_settings_registration_mode',
      sql`${t.registrationMode} IN ('invite_only', 'open')`,
    ),
  ],
);

/* ---- Better Auth 1.6 auth-plane tables (#3). Complete 1.6.23 shapes;
 * consumed by the drizzle adapter via an explicit singular-model→plural-table
 * map. snake_case columns. ---- */

export const sessions = pgTable(
  'session',
  {
    id: id(),
    token: text('token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('session_token_unique').on(t.token), index('session_user_idx').on(t.userId)],
);

export const accounts = pgTable(
  'account',
  {
    id: id(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    // scrypt credential for email/password accounts — never logged.
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('account_user_idx').on(t.userId)],
);

export const verifications = pgTable(
  'verification',
  {
    id: id(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

/** Schema-only stub — the org/team feature is deferred (TODOS.md Deferred). */
export const organizations = pgTable('organization', {
  id: id(),
  name: text('name').notNull(),
  ownerUserId: text('owner_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
});

/** Ownership columns shared by every directly-owned table (§11.1). `org_id`
 * is an unused stub until the deferred org change. */
const owned = {
  ownerUserId: () =>
    text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  orgId: () => text('org_id').references(() => organizations.id),
};

export const agents = pgTable(
  'agent',
  {
    id: id(),
    ownerUserId: owned.ownerUserId(),
    orgId: owned.orgId(),
    name: text('name').notNull(),
    apiKeyHash: text('api_key_hash').notNull(),
    apiKeyPrefix: text('api_key_prefix').notNull(),
    harnessType: text('harness_type').notNull(),
    /** Per-agent body-capture override (add-body-capture): 'always' | 'never';
     * null = inherit the owner's global mode. INERT while the global mode is
     * 'off' — the master switch is the consent boundary. */
    bodyCaptureOverride: text('body_capture_override'),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('agent_api_key_prefix_unique').on(t.apiKeyPrefix),
    index('agent_owner_idx').on(t.ownerUserId),
    check(
      'agent_body_capture_override_valid',
      sql`${t.bodyCaptureOverride} IS NULL OR ${t.bodyCaptureOverride} IN ('always', 'never')`,
    ),
  ],
);

/** Per-provider upstream-timeout overrides (fix-long-call-timeouts): null =
 * inherit the instance defaults; set = 1s–1h patience for slow/long-thinking
 * models (research-class), resolved `override ?? env` per chain attempt. */
export const providers = pgTable(
  'provider',
  {
    id: id(),
    ownerUserId: owned.ownerUserId(),
    orgId: owned.orgId(),
    name: text('name').notNull(),
    kind: text('kind').notNull(), // api_key | subscription | custom | local
    protocol: text('protocol').notNull(), // openai_compatible | anthropic_compatible
    baseUrl: text('base_url'),
    encryptedCredentials: text('encrypted_credentials'),
    status: text('status').default('unknown').notNull(),
    // Per-provider outbound token-cap spelling (add-max-tokens-spelling). Value is the
    // literal OpenAI wire field (`max_completion_tokens` | `max_tokens`) or `auto`
    // (kind-derived: local→max_tokens, else max_completion_tokens). openai_compatible
    // only; inert on other protocols. NOT NULL so the resolver never sees a fourth state.
    maxTokensSpelling: text('max_tokens_spelling').default('auto').notNull(),
    // Subscription-OAuth display/state metadata (add-subscription-oauth). NON-SECRET:
    // tokens live only inside encrypted_credentials (invariant 8). `oauth_preset` names
    // the bundled preset for an OAuth-connected provider; `credential_expires_at` mirrors
    // the access token's expiry for the UI (never an auth input — the envelope is
    // authoritative); `credential_error` is the durable credential state the dashboard
    // reads after reload ('reauthorize_required', extensible).
    oauthPreset: text('oauth_preset'),
    credentialExpiresAt: timestamp('credential_expires_at', { withTimezone: true }),
    credentialError: text('credential_error'),
    firstByteTimeoutMs: integer('first_byte_timeout_ms'),
    idleTimeoutMs: integer('idle_timeout_ms'),
    createdAt: createdAt(),
  },
  (t) => [
    index('provider_owner_idx').on(t.ownerUserId),
    check(
      'provider_first_byte_timeout_range',
      sql`${t.firstByteTimeoutMs} IS NULL OR (${t.firstByteTimeoutMs} >= 1000 AND ${t.firstByteTimeoutMs} <= 3600000)`,
    ),
    check(
      'provider_idle_timeout_range',
      sql`${t.idleTimeoutMs} IS NULL OR (${t.idleTimeoutMs} >= 1000 AND ${t.idleTimeoutMs} <= 3600000)`,
    ),
  ],
);

export const models = pgTable(
  'model',
  {
    id: id(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    externalModelId: text('external_model_id').notNull(),
    displayName: text('display_name'),
    contextWindow: integer('context_window'),
    supportsTools: boolean('supports_tools').default(false).notNull(),
    supportsVision: boolean('supports_vision').default(false).notNull(),
    supportsReasoning: boolean('supports_reasoning').default(false).notNull(),
    inputPricePer1m: doublePrecision('input_price_per_1m'),
    outputPricePer1m: doublePrecision('output_price_per_1m'),
    isFree: boolean('is_free').default(false).notNull(),
    // Provider-listed price captured at sync as an estimate (add-provider-price-
    // sync-and-edit). Deliberately DISTINCT from the user-price columns above: these
    // never enter the `model_prices` catalog. They DO feed `resolveModelPrice` as a
    // clearly-marked, LAST-resort fallback (`source: listed`) when the catalog
    // (exact + native-family) is unknown — never overriding it, snapshotted immutably
    // (invariant 4's listed-fallback exception; record-listed-price-fallback).
    // Per-provider; rewritten on every sync
    // (set from the listed price, or cleared to null when none is listed); cleared on a
    // base_url/protocol change. `listed_is_free` is null when no estimate exists and is
    // true only when every monetary dimension the provider lists is zero.
    listedInputPricePer1m: doublePrecision('listed_input_price_per_1m'),
    listedOutputPricePer1m: doublePrecision('listed_output_price_per_1m'),
    listedIsFree: boolean('listed_is_free'),
    listedPriceCapturedAt: timestamp('listed_price_captured_at', { withTimezone: true }),
    // DERIVED aggregator SKU variant (add-model-variant-detection): null = none.
    // Written for every admitted model on EVERY sync — set or cleared, and carried
    // in the upsert's ON CONFLICT set so a re-sync corrects it rather than freezing
    // the first-insert value. Scoped to aggregator billing families (a direct or
    // custom provider's id that merely looks suffixed is never classified), cleared
    // when the provider's base_url/protocol moves, and re-derivable at any time from
    // the id — never authored by a user. Routability is DERIVED from this value
    // (`NON_ROUTABLE_VARIANTS`), never stored as its own flag that could drift.
    variant: text('variant'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('model_provider_external_unique').on(t.providerId, t.externalModelId),
    index('model_provider_idx').on(t.providerId),
  ],
);

export const tiers = pgTable(
  'tier',
  {
    id: id(),
    ownerUserId: owned.ownerUserId(),
    orgId: owned.orgId(),
    key: text('key').notNull(),
    displayName: text('display_name'),
    description: text('description'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('tier_owner_key_unique').on(t.ownerUserId, t.key),
    index('tier_owner_idx').on(t.ownerUserId),
  ],
);

/** Ordered tier↔model chain. `position` is NOT NULL — PostgreSQL CHECKs pass
 * NULL and uniques admit multiple NULLs, so nullability would void the §7.4
 * five-models-per-tier cap this table enforces. */
export const routingEntries = pgTable(
  'routing_entry',
  {
    id: id(),
    tierId: text('tier_id')
      .notNull()
      .references(() => tiers.id, { onDelete: 'cascade' }),
    modelId: text('model_id')
      .notNull()
      .references(() => models.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    // Which execution mode this entry is reserved for (add-batch-mode-routing).
    // `any` carries no restriction and is what every entry predating the column
    // is: a synchronous walk may use it and a batch may resolve to it. `batch`
    // RESERVES the entry — a synchronous walk excludes it before position 0
    // (`fallback-routing`), and a batch prefers it (`batch-inference`). NOT NULL
    // with a default so the migration needs no backfill and no row can present a
    // fourth state to the resolver.
    mode: text('mode').default('any').notNull(),
  },
  (t) => [
    uniqueIndex('routing_entry_tier_position_unique').on(t.tierId, t.position),
    index('routing_entry_tier_idx').on(t.tierId),
    check('routing_entry_position_range', sql`${t.position} BETWEEN 0 AND 4`),
    // The taxonomy is closed at the database, so widening it is a deliberate
    // migration rather than an accident of an application write.
    check('routing_entry_mode_valid', sql`${t.mode} IN ('any', 'batch')`),
  ],
);

export const routingRules = pgTable(
  'routing_rule',
  {
    id: id(),
    ownerUserId: owned.ownerUserId(),
    orgId: owned.orgId(),
    matchType: text('match_type').notNull(), // header | default | auto_high | auto_low | auto_workload
    headerName: text('header_name').default('x-polyrouter-tier').notNull(),
    headerValue: text('header_value'),
    // The ONE workload class an `auto_workload` rule binds (add-workload-routing
    // D1): required on that match type, forbidden on every other; never `none`.
    workloadClass: text('workload_class'), // claim class (auto_workload) or band SCOPE (auto_high/auto_low)
    target: text('target').notNull(),
    priority: integer('priority').default(0).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('routing_rule_owner_idx').on(t.ownerUserId),
    // The class/match-type SCOPE rule is a store guarantee, not a convention
    // (add-workload-scoped-bands replaces W-2's pairing): an `auto_workload`
    // rule REQUIRES a class (the claim), a band rule (`auto_high`/`auto_low`)
    // MAY carry one (a scope — that band target applies only to requests of
    // the class), and `header`/`default` never carry one. Explicit three-way
    // predicate so `(auto_workload, NULL)` cannot slip through a NULL branch.
    check(
      'routing_rule_workload_class_scope',
      sql`(${t.matchType} = 'auto_workload' AND ${t.workloadClass} IS NOT NULL) OR ${t.matchType} IN ('auto_high', 'auto_low') OR (${t.matchType} NOT IN ('auto_workload', 'auto_high', 'auto_low') AND ${t.workloadClass} IS NULL)`,
    ),
    check(
      'routing_rule_workload_class_valid',
      sql`${t.workloadClass} IS NULL OR ${t.workloadClass} IN ('code', 'research', 'vision', 'structured', 'writing')`,
    ),
    check(
      'routing_rule_workload_no_header_value',
      sql`${t.matchType} <> 'auto_workload' OR ${t.headerValue} IS NULL`,
    ),
  ],
);

/** Global (non-tenant) effective-dated pricing/capability catalog (#8, §7.7).
 * Append-only + monotonic: a price change is a new `valid_from` row, never an
 * update — cost is immutable (invariant 4). Keyed by a provider-namespaced
 * `model_key` (`"<litellm_provider>:<model>"`) so a reseller's `gpt-4o` can't
 * inherit OpenAI's price. USD per 1M tokens (single-currency invariant). */
export const modelPrices = pgTable(
  'model_price',
  {
    id: id(),
    modelKey: text('model_key').notNull(),
    inputPricePer1m: doublePrecision('input_price_per_1m').notNull(),
    outputPricePer1m: doublePrecision('output_price_per_1m').notNull(),
    cacheReadPricePer1m: doublePrecision('cache_read_price_per_1m'),
    cacheWritePricePer1m: doublePrecision('cache_write_price_per_1m'),
    contextWindow: integer('context_window'),
    // Output cap (add-output-cap-guardrails): null = unknown, never 0.
    maxOutputTokens: integer('max_output_tokens'),
    supportsTools: boolean('supports_tools').default(false).notNull(),
    supportsVision: boolean('supports_vision').default(false).notNull(),
    supportsReasoning: boolean('supports_reasoning').default(false).notNull(),
    isFree: boolean('is_free').default(false).notNull(),
    // Asynchronous batch-tier rates (add-batch-inference): USD per 1M, present
    // TOGETHER or absent together (a half rate is never stored), null = batch
    // rate unknown — never "free". Participates in change detection like a cap.
    batchInputPricePer1m: doublePrecision('batch_input_price_per_1m'),
    batchOutputPricePer1m: doublePrecision('batch_output_price_per_1m'),
    source: text('source').notNull(), // bundled | refresh | manual
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('model_price_key_valid_from_unique').on(t.modelKey, t.validFrom),
    check(
      'model_price_batch_pair',
      sql`(${t.batchInputPricePer1m} IS NULL) = (${t.batchOutputPricePer1m} IS NULL)`,
    ),
    check(
      'model_price_batch_nonneg',
      sql`(${t.batchInputPricePer1m} IS NULL OR ${t.batchInputPricePer1m} >= 0)
        AND (${t.batchOutputPricePer1m} IS NULL OR ${t.batchOutputPricePer1m} >= 0)`,
    ),
    check(
      'model_price_max_output_positive',
      sql`${t.maxOutputTokens} IS NULL OR ${t.maxOutputTokens} > 0`,
    ),
    check(
      'model_price_nonneg',
      sql`${t.inputPricePer1m} >= 0 AND ${t.outputPricePer1m} >= 0
        AND (${t.cacheReadPricePer1m} IS NULL OR ${t.cacheReadPricePer1m} >= 0)
        AND (${t.cacheWritePricePer1m} IS NULL OR ${t.cacheWritePricePer1m} >= 0)`,
    ),
    check(
      'model_price_free_zero',
      sql`NOT ${t.isFree} OR (${t.inputPricePer1m} = 0 AND ${t.outputPricePer1m} = 0)`,
    ),
  ],
);

/** Immutable per-request metadata + cost record (#11, spec §5/§7.5/§7.7;
 * invariant 4). `agent_id`/`provider_id`/`model_id` are DENORMALIZED plain ids
 * (NOT foreign keys): an append-only audit row must survive — and not fail to
 * insert on — a concurrent provider/model/agent deletion, and keep the historical
 * id. Unit prices are SNAPSHOTTED here and cost is computed once at request time
 * (never recomputed); `cost`/snapshots are null when the price is unknown. Token
 * counts are UNCACHED input + output, with cache tokens separate. USD-only. No
 * prompt/response bodies (invariant 8). */
export const requestLogs = pgTable(
  'request_log',
  {
    id: id(),
    ownerUserId: owned.ownerUserId(),
    orgId: owned.orgId(),
    agentId: text('agent_id'),
    providerId: text('provider_id'),
    modelId: text('model_id'),
    tierAssigned: text('tier_assigned'),
    decisionLayer: text('decision_layer').notNull(),
    routingReason: text('routing_reason').notNull(),
    // The header that CHOSE the route (add-routing-header-visibility): set only
    // on decision_layer='header' rows. x-polyrouter-tier records name + the
    // matched OWNED value — the tier key on a direct lookup, or the remap rule's
    // header_value (the tier-ask category) on a remap (record-tier-header-value).
    // A rule on any OTHER header records its normalized name with a NULL value (a
    // configured header_value there can itself be a credential — never persisted).
    // Null = other layers or rows predating the columns.
    routingHeaderName: text('routing_header_name'),
    routingHeaderValue: text('routing_header_value'),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cacheReadTokens: integer('cache_read_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    inputPriceSnapshot: doublePrecision('input_price_snapshot'),
    outputPriceSnapshot: doublePrecision('output_price_snapshot'),
    cacheReadPriceSnapshot: doublePrecision('cache_read_price_snapshot'),
    cacheWritePriceSnapshot: doublePrecision('cache_write_price_snapshot'),
    priceVersionId: text('price_version_id'),
    // Snapshot provenance verbatim (add-native-price-fallback):
    // model|local|bundled|refresh|manual|native_family; null = unpriced or predates
    // the column. 'native_family' is the estimate marker.
    priceSource: text('price_source'),
    // Which pricing rule the snapshot came from (add-batch-inference): 'sync' —
    // resolved when the request completed — or 'batch' — the job's submit-time
    // snapshot copied verbatim at settlement. Null = predates the column, read as
    // 'sync'. A synchronous rate is never used for a batch item, nor the reverse.
    priceMode: text('price_mode'),
    // Batch membership (add-batch-inference): the job this item settled under.
    // Plain text, NO foreign key — an item's ledger row outlives its job, and the
    // job carries the `custom_id` mapping only through its results stream (never a
    // column here). Indexed for the listing's `batchId` filter and the live band's
    // targeted existence read. Null = a synchronous request.
    batchId: text('batch_id'),
    // The SERVING provider's kind, snapshotted immutably (split-subscription-spend).
    // Decides whether this row's cost is money owed (`api_key`/`custom`/`local` → cash)
    // or traffic already paid for at a flat rate (`subscription` → notional, excluded
    // from reported spend). NULL = unknown, i.e. predates this column.
    //
    // Do NOT "simplify" this by joining `providers`: `provider_id` above is denormalized
    // with no FK, the provider may be deleted, and `kind` is mutable — a join would let
    // today's configuration reclassify a past request's billing character, which is the
    // same rewrite-history failure cost immutability exists to prevent (invariant 4).
    // Divergence from the current providers row IS the historical record.
    providerKind: text('provider_kind'),
    usageEstimated: boolean('usage_estimated').default(false).notNull(),
    cost: doublePrecision('cost'),
    durationMs: integer('duration_ms').notNull(),
    status: text('status').notNull(), // success | error (fallback/escalated: #12/#13)
    // L1 decision telemetry (add-auto-decision-telemetry): the verdict of the
    // structural layer when it EVALUATED the request — band high|low|ambiguous,
    // the final adjusted score, and the band's provenance threshold|declared.
    // Null = not evaluated (non-auto, disabled, degradation) or pre-capture.
    structuralBand: text('structural_band'),
    structuralScore: doublePrecision('structural_score'),
    structuralBandSource: text('structural_band_source'),
    // L2 decision telemetry (add-semantic-routing): the semantic verdict when
    // Layer 2 EVALUATED the request — band, 4-decimal score in [-2,2], the
    // active classification source, and the opaque provenance digest. ALL
    // FOUR travel together (CHECK below); null = not evaluated / pre-capture.
    semanticBand: text('semantic_band'),
    semanticScore: doublePrecision('semantic_score'),
    semanticSource: text('semantic_source'),
    semanticRevision: text('semantic_revision'),
    // Workload telemetry (add-workload-telemetry): the workload verdict when the
    // classifier EVALUATED the request — class (taxonomy ∪ 'none'), confidence
    // in [0,1], the producing source (structural|semantic), and the taxonomy +
    // classifier + threshold revision stamp. ALL FOUR travel together (CHECK
    // below); the structural source never carries a reserved class; null =
    // not evaluated / pre-capture (unknown-not-wrong, never backfilled).
    workloadClass: text('workload_class'),
    workloadScore: doublePrecision('workload_score'),
    workloadSource: text('workload_source'),
    workloadRevision: text('workload_revision'),
    // Terminal provider-error detail (add-request-error-detail): set ONLY on
    // status='error' rows; null for non-error rows and rows predating capture
    // (unknown-not-wrong, never backfilled). `error_message` is the factory-
    // sanitized provider-verbatim text (≤300); `error_request_id` allowlisted.
    errorKind: text('error_kind'),
    errorStatus: integer('error_status'),
    errorMessage: text('error_message'),
    errorRequestId: text('error_request_id'),
    // Per-attempt failure metadata (add-fallback-attempt-detail): the pre-commit
    // walked failure/skip trail across every executed leg, set ONLY on
    // status='error' rows; null for non-error rows and rows predating the
    // column (unknown-not-wrong, never backfilled). Structure only — the entry
    // shape admits no free-text field (invariant 8).
    attemptFailures: jsonb('attempt_failures').$type<AttemptFailureEntry[]>(),
    escalated: boolean('escalated').default(false).notNull(),
    qualitySignal: doublePrecision('quality_signal'),
    /** WHY the cascade escalated (add-auto-threshold-calibration):
     * 'quality_gate' = the gate SCORED the cheap answer below threshold;
     * 'cheap_error' = every other pre-commit escalation (retryable failure,
     * timeout, replay-materialization failure after a passing verdict).
     * Null = not escalated or predates the column (never backfilled). */
    escalationSource: text('escalation_source'),
    /** The tenant's calibration_epoch at DECISION time for evaluated rows —
     * the calibrator's freshness stamp (immune to async writer lag). */
    structuralEpoch: integer('structural_epoch'),
    createdAt: createdAt(),
  },
  (t) => [
    index('request_log_created_idx').on(t.createdAt),
    index('request_log_owner_idx').on(t.ownerUserId),
    // Composite (owner, created) for the #16 per-period budget-reconcile scan
    // (a spend sum over one owner's current window) — the owner-only + created-only
    // singles above don't serve that predicate as tightly.
    index('request_log_owner_created_idx').on(t.ownerUserId, t.createdAt),
    index('request_log_agent_idx').on(t.agentId),
    index('request_log_provider_idx').on(t.providerId),
    index('request_log_model_idx').on(t.modelId),
    index('request_log_batch_idx').on(t.batchId),
    check(
      'request_log_tokens_nonneg',
      sql`${t.inputTokens} >= 0 AND ${t.outputTokens} >= 0
        AND (${t.cacheReadTokens} IS NULL OR ${t.cacheReadTokens} >= 0)
        AND (${t.cacheWriteTokens} IS NULL OR ${t.cacheWriteTokens} >= 0)`,
    ),
    // A header VALUE never exists without its NAME (value-requires-name; the
    // name-only state is legitimate — custom rules record no value).
    check(
      'request_log_routing_header_pair',
      sql`${t.routingHeaderValue} IS NULL OR ${t.routingHeaderName} IS NOT NULL`,
    ),
    // `providers.kind` has no CHECK of its own, so constrain it HERE: the spend
    // classification partitions on this value, and an unexpected one would land in no
    // defined component. NULL stays legal — it is the honest "predates the column".
    check(
      'request_log_provider_kind_known',
      sql`${t.providerKind} IS NULL OR ${t.providerKind} IN ('api_key','subscription','custom','local')`,
    ),
    // Provenance is binary and only ever on escalated rows (fail-closed).
    check(
      'request_log_escalation_source_valid',
      sql`${t.escalationSource} IS NULL OR (${t.escalationSource} IN ('quality_gate', 'cheap_error') AND ${t.escalated})`,
    ),
    // The four semantic columns travel together; band/source are enums-or-
    // null; the score is DB-bounded to the classifier's [-2, 2] range
    // (add-semantic-routing D4).
    check(
      'request_log_semantic_quad',
      sql`(${t.semanticBand} IS NULL) = (${t.semanticScore} IS NULL) AND (${t.semanticBand} IS NULL) = (${t.semanticSource} IS NULL) AND (${t.semanticBand} IS NULL) = (${t.semanticRevision} IS NULL)`,
    ),
    check(
      'request_log_semantic_band_valid',
      sql`${t.semanticBand} IS NULL OR ${t.semanticBand} IN ('high', 'low', 'ambiguous')`,
    ),
    check(
      'request_log_semantic_source_valid',
      sql`${t.semanticSource} IS NULL OR ${t.semanticSource} IN ('bundled', 'learned')`,
    ),
    check(
      'request_log_semantic_score_range',
      sql`${t.semanticScore} IS NULL OR (${t.semanticScore} >= -2 AND ${t.semanticScore} <= 2)`,
    ),
    // The four workload columns travel together (add-workload-telemetry D4);
    // class/source are enums-or-null; the structural source can never carry a
    // reserved (semantic-only) class; the score is DB-bounded to [0, 1].
    check(
      'request_log_workload_quad',
      sql`(${t.workloadClass} IS NULL) = (${t.workloadScore} IS NULL) AND (${t.workloadClass} IS NULL) = (${t.workloadSource} IS NULL) AND (${t.workloadClass} IS NULL) = (${t.workloadRevision} IS NULL)`,
    ),
    check(
      'request_log_workload_class_valid',
      sql`${t.workloadClass} IS NULL OR ${t.workloadClass} IN ('code', 'research', 'vision', 'structured', 'writing', 'none')`,
    ),
    check(
      'request_log_workload_source_valid',
      sql`${t.workloadSource} IS NULL OR ${t.workloadSource} IN ('structural', 'semantic')`,
    ),
    check(
      'request_log_workload_structural_compat',
      sql`${t.workloadSource} IS DISTINCT FROM 'structural' OR ${t.workloadClass} IN ('code', 'vision', 'structured', 'none')`,
    ),
    check(
      'request_log_workload_score_range',
      sql`${t.workloadScore} IS NULL OR (${t.workloadScore} >= 0 AND ${t.workloadScore} <= 1)`,
    ),
    // Batch rows (add-batch-inference): the mode is an enum-or-null, and a
    // batch-priced row always names its job — a batch snapshot without a job would
    // be a cost nobody can trace to a settlement.
    check(
      'request_log_price_mode_valid',
      sql`${t.priceMode} IS NULL OR ${t.priceMode} IN ('sync', 'batch')`,
    ),
    check(
      'request_log_batch_price_mode_compat',
      sql`${t.priceMode} IS DISTINCT FROM 'batch' OR ${t.batchId} IS NOT NULL`,
    ),
  ],
);

/** Per-billable-call cost ledger for a request (#14 cascade). `request_log` is
 * the one-per-request served summary; a `request_attempt` row records each
 * ADDITIONAL billable upstream call (the superseded cheap attempt on a cascade
 * escalation) at its own immutable snapshot price (invariant 4). Total request
 * spend = `request_log.cost` + Σ `request_attempt.cost`. Owner-scoped
 * (invariant 5); cascade-deleted with its request. No prompt/response bodies. */
export const requestAttempts = pgTable(
  'request_attempt',
  {
    id: id(),
    requestLogId: text('request_log_id')
      .notNull()
      .references(() => requestLogs.id, { onDelete: 'cascade' }),
    ownerUserId: owned.ownerUserId(),
    orgId: owned.orgId(),
    attemptIndex: integer('attempt_index').notNull(),
    tierKey: text('tier_key'),
    providerId: text('provider_id'),
    modelId: text('model_id'),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cacheReadTokens: integer('cache_read_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    inputPriceSnapshot: doublePrecision('input_price_snapshot'),
    outputPriceSnapshot: doublePrecision('output_price_snapshot'),
    cacheReadPriceSnapshot: doublePrecision('cache_read_price_snapshot'),
    cacheWritePriceSnapshot: doublePrecision('cache_write_price_snapshot'),
    priceVersionId: text('price_version_id'),
    // Same provenance on the attempt ledger — an estimate hiding in a superseded
    // attempt must be discoverable (add-native-price-fallback).
    priceSource: text('price_source'),
    // Same snapshot on the attempt ledger — a superseded attempt can be served by a
    // provider of a different kind than the one that finally served the request, so each
    // row records its OWN serving provider's kind (split-subscription-spend).
    providerKind: text('provider_kind'),
    usageEstimated: boolean('usage_estimated').default(false).notNull(),
    cost: doublePrecision('cost'),
    status: text('status').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('request_attempt_request_idx').on(t.requestLogId),
    index('request_attempt_owner_idx').on(t.ownerUserId),
    // Composite (owner, created) for the #16 reconcile scan — the attempt ledger
    // otherwise has no `created_at` index, so a per-period owner spend sum would
    // seq-scan the ledger.
    index('request_attempt_owner_created_idx').on(t.ownerUserId, t.createdAt),
    check(
      'request_attempt_tokens_nonneg',
      sql`${t.inputTokens} >= 0 AND ${t.outputTokens} >= 0
        AND (${t.cacheReadTokens} IS NULL OR ${t.cacheReadTokens} >= 0)
        AND (${t.cacheWriteTokens} IS NULL OR ${t.cacheWriteTokens} >= 0)`,
    ),
    check(
      'request_attempt_provider_kind_known',
      sql`${t.providerKind} IS NULL OR ${t.providerKind} IN ('api_key','subscription','custom','local')`,
    ),
  ],
);

/** Owner-scoped notification channels (#15a, spec §5/§10.1). `encryptedConfig`
 * holds the whole kind-specific config (SMTP host/port/creds or Apprise URLs)
 * AES-GCM at rest (invariant 8); never a plaintext credential. `eventsSubscribed`
 * is a CSV of event types. The delivery layer (queue/worker) lives in the
 * control plane. */
export const notificationChannels = pgTable(
  'notification_channel',
  {
    id: id(),
    ownerUserId: owned.ownerUserId(),
    orgId: owned.orgId(),
    name: text('name').notNull(),
    kind: text('kind').notNull(), // smtp | apprise
    enabled: boolean('enabled').default(true).notNull(),
    encryptedConfig: text('encrypted_config').notNull(),
    eventsSubscribed: text('events_subscribed').notNull(),
    lastTestAt: timestamp('last_test_at', { withTimezone: true }),
    lastTestStatus: text('last_test_status'),
    createdAt: createdAt(),
  },
  (t) => [index('notification_channel_owner_idx').on(t.ownerUserId)],
);

/** Owner-scoped spend budget (#16, spec §5 Limit / §10). Table name `budget`
 * avoids the `limit` SQL keyword. `scope='global'` meters all of the owner's
 * spend; `scope='agent'` meters one agent (its `agent_id`, denormalized — not an
 * FK, so a deleted agent leaves the budget inert, not a cascade). `window` is a
 * UTC calendar period (day/week/month) that resets at the boundary; `action`
 * `alert` emits a notification, `block` rejects new requests in the proxy path.
 * `amount` is a USD threshold (≤ 1e9 so `round(amount×1e6)` stays a safe
 * integer). `notify_channel_ids` is a CSV of the channels an alert/block targets
 * (empty = all subscribed). The Redis spend counter is reconciled from the
 * request-log ledgers, never a column here (invariant 4/10). */
export const budgets = pgTable(
  'budget',
  {
    id: id(),
    ownerUserId: owned.ownerUserId(),
    orgId: owned.orgId(),
    name: text('name').notNull(),
    scope: text('scope').notNull(), // global | agent
    agentId: text('agent_id'), // set iff scope='agent'
    window: text('window').notNull(), // day | week | month
    action: text('action').notNull(), // alert | block
    // What this budget meters (split-subscription-spend). `cash` counts money owed
    // (the cash + unknown components); `notional` additionally counts subscription
    // traffic priced at the vendor's API rate — an imperfect but real proxy for a
    // flat-rate plan's finite capacity, and the ONLY usage throttle the product has.
    // Existing budgets are backfilled to `notional` so upgrading changes nobody's
    // enforcement; new budgets default to `cash` at the application layer.
    meteringBasis: text('metering_basis').default('notional').notNull(),
    amount: doublePrecision('amount').notNull(), // USD threshold
    notifyChannelIds: text('notify_channel_ids').default('').notNull(), // csv
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('budget_owner_idx').on(t.ownerUserId),
    check('budget_amount_range', sql`${t.amount} > 0 AND ${t.amount} <= 1000000000`),
    check('budget_scope_valid', sql`${t.scope} IN ('global', 'agent')`),
    check('budget_window_valid', sql`${t.window} IN ('day', 'week', 'month')`),
    check('budget_action_valid', sql`${t.action} IN ('alert', 'block')`),
    check('budget_metering_basis_valid', sql`${t.meteringBasis} IN ('cash', 'notional')`),
    // An agent budget has an agent; a global budget has none.
    check('budget_agent_iff_scope', sql`(${t.scope} = 'agent') = (${t.agentId} IS NOT NULL)`),
  ],
);

/** Per-tenant automatic-routing layer preferences (#20, spec §9). One row per
 * owner (unique) — the tenant's structural/cascade on/off PREFERENCE. Absent =
 * inherit the instance capability (`ROUTING_AUTO_LAYERS`). The proxy reads it on
 * the auto→default path; effective = capability AND (preference, default on).
 * The check backstops the write-time "cascade implies structural" normalization. */
export const routingSettings = pgTable(
  'routing_settings',
  {
    id: id(),
    ownerUserId: owned.ownerUserId(),
    orgId: owned.orgId(),
    structuralEnabled: boolean('structural_enabled').notNull(),
    cascadeEnabled: boolean('cascade_enabled').notNull(),
    /** L2 preference (add-semantic-routing). Backfilled from structural at
     * migration (a full opt-out stays a full opt-out); semantic⇒structural
     * is DB-checked; PUT normalization is atomic in the upsert. */
    semanticEnabled: boolean('semantic_enabled').default(true).notNull(),
    /** L2 learning preference (add-semantic-learning; default OFF, opt-in).
     * `learning ⇒ semantic ⇒ structural` (DB-checked). The REVOCATION epoch
     * bumps only on revert/config change (invalidates all older learned
     * state); the ACTIVE generation bumps on each successful sweep apply
     * (versions the readable state) — the two are distinct (clink r1 High-3). */
    semanticLearningEnabled: boolean('semantic_learning_enabled').default(false).notNull(),
    semanticLearningEpoch: integer('semantic_learning_epoch').default(0).notNull(),
    semanticLearningGeneration: integer('semantic_learning_generation').default(0).notNull(),
    /** Threshold calibration (add-auto-threshold-calibration). The enabled
     * flag gates the calibrator's MOVES only; a stored pair applies while
     * anchor- and rail-valid regardless (disable = stop moving, keep values).
     * The anchor is the instance defaults the pair was calibrated against —
     * a mismatch inerts the pair until the hygiene pass rebases it. The
     * epoch bumps on EVERY threshold event; evaluated request rows stamp it
     * (decision-time freshness for calibration evidence). */
    calibrationEnabled: boolean('calibration_enabled').default(false).notNull(),
    calibratedHigh: doublePrecision('calibrated_high'),
    calibratedLow: doublePrecision('calibrated_low'),
    calibratedAnchorHigh: doublePrecision('calibrated_anchor_high'),
    calibratedAnchorLow: doublePrecision('calibrated_anchor_low'),
    calibrationEpoch: integer('calibration_epoch').default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('routing_settings_owner_unique').on(t.ownerUserId),
    check(
      'routing_settings_cascade_implies_structural',
      sql`NOT ${t.cascadeEnabled} OR ${t.structuralEnabled}`,
    ),
    check(
      'routing_settings_semantic_implies_structural',
      sql`NOT ${t.semanticEnabled} OR ${t.structuralEnabled}`,
    ),
    check(
      'routing_settings_learning_implies_semantic',
      sql`NOT ${t.semanticLearningEnabled} OR ${t.semanticEnabled}`,
    ),
    // The four calibrated_* columns travel together (all null or all set).
    check(
      'routing_settings_calibration_quad',
      sql`(${t.calibratedHigh} IS NULL) = (${t.calibratedLow} IS NULL) AND (${t.calibratedHigh} IS NULL) = (${t.calibratedAnchorHigh} IS NULL) AND (${t.calibratedHigh} IS NULL) = (${t.calibratedAnchorLow} IS NULL)`,
    ),
    check(
      'routing_settings_calibration_range',
      sql`${t.calibratedHigh} IS NULL OR (${t.calibratedLow} >= 0 AND ${t.calibratedHigh} <= 1 AND ${t.calibratedLow} < ${t.calibratedHigh})`,
    ),
  ],
);

/** Owner-scoped body-capture settings singleton (add-body-capture, invariant 8's
 * opt-in door). A MISSING row ≡ mode 'off' (fail-closed); a malformed row reads
 * as 'off'. `capture_epoch` is the deletion-revocation counter: purge-all /
 * disable-with-purge bump it under the row's FOR UPDATE lock — the writer's
 * guarded insert re-reads it post-lock and discards stale drafts. `retention_days`
 * null = infinite, reachable only through the explicit keep-forever choice. */
export const bodyCaptureSettings = pgTable(
  'body_capture_settings',
  {
    id: id(),
    ownerUserId: owned.ownerUserId(),
    orgId: owned.orgId(),
    mode: text('mode').default('off').notNull(),
    retentionDays: integer('retention_days').default(30),
    captureEpoch: integer('capture_epoch').default(0).notNull(),
    droppedCount: integer('dropped_count').default(0).notNull(),
    lastPurgeAt: timestamp('last_purge_at', { withTimezone: true }),
    lastPurgeCount: integer('last_purge_count').default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('body_capture_settings_owner_unique').on(t.ownerUserId),
    check('body_capture_mode_valid', sql`${t.mode} IN ('off', 'errors_only', 'all')`),
    check(
      'body_capture_retention_valid',
      sql`${t.retentionDays} IS NULL OR (${t.retentionDays} >= 1 AND ${t.retentionDays} <= 3650)`,
    ),
    check(
      'body_capture_counters_nonneg',
      sql`${t.captureEpoch} >= 0 AND ${t.droppedCount} >= 0 AND ${t.lastPurgeCount} >= 0`,
    ),
  ],
);

/** Captured prompt/response bodies (add-body-capture) — CIPHERTEXT ONLY
 * (encryptSecret output; plaintext never touches the table or logs). Deletable
 * operational data, NOT audit: FK CASCADE with the request row. `bytes` is the
 * pre-encryption plaintext size; `truncated` = stopped at the cap; `partial` =
 * assembly ended early (cancel / post-commit error). */
export const requestBodies = pgTable(
  'request_body',
  {
    id: id(),
    ownerUserId: owned.ownerUserId(),
    orgId: owned.orgId(),
    requestLogId: text('request_log_id')
      .notNull()
      .references(() => requestLogs.id, { onDelete: 'cascade' }),
    direction: text('direction').notNull(),
    contentEncrypted: text('content_encrypted').notNull(),
    bytes: integer('bytes').notNull(),
    truncated: boolean('truncated').default(false).notNull(),
    partial: boolean('partial').default(false).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('request_body_request_direction_unique').on(t.requestLogId, t.direction),
    index('request_body_owner_created_idx').on(t.ownerUserId, t.createdAt),
    check('request_body_direction_valid', sql`${t.direction} IN ('request', 'response')`),
    check('request_body_bytes_nonneg', sql`${t.bytes} >= 0`),
  ],
);

/** Per-request deletion tombstone (add-body-capture): the guarded insert checks
 * it under the owner lock, so a queued/retrying/timed-out write can never
 * resurrect deleted bodies. Retained for the PARENT ROW'S lifetime (FK CASCADE)
 * — provably outlives every writer path; never age-GC'd. */
export const requestBodyTombstones = pgTable(
  'request_body_tombstone',
  {
    requestLogId: text('request_log_id')
      .primaryKey()
      .references(() => requestLogs.id, { onDelete: 'cascade' }),
    ownerUserId: owned.ownerUserId(),
    orgId: owned.orgId(),
    createdAt: createdAt(),
  },
  (t) => [index('request_body_tombstone_owner_idx').on(t.ownerUserId)],
);

/** Append-only refresh-run ledger (add-pricing-refresh-ui): one row per
 * COMPLETED refresh-endpoint/scheduler apply, inserted ATOMICALLY with the
 * version apply inside the pricing advisory-lock transaction. Instance-global
 * (no owner — the catalog is shared); `kind` is the endpoint's full source
 * vocabulary; boot seeding records nothing. `lastRefresh` status derives from
 * the newest `litellm`-kind row. */
export const pricingRefreshRuns = pgTable(
  'pricing_refresh_run',
  {
    id: id(),
    kind: text('kind').notNull(),
    added: integer('added').notNull(),
    skipped: integer('skipped').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('pricing_refresh_run_kind_created_idx').on(t.kind, t.createdAt),
    check('pricing_refresh_run_kind_valid', sql`${t.kind} IN ('litellm', 'body', 'bundled')`),
    check('pricing_refresh_run_counts_nonneg', sql`${t.added} >= 0 AND ${t.skipped} >= 0`),
  ],
);

/** Append-only threshold-calibration audit (add-auto-threshold-calibration).
 * old/new are the FULL numeric effective pairs before/after the event (never
 * null-as-instance); anchor_* is the anchor governing AFTER the event. The
 * reason is a numbers-only serialization (invariant 8). */
export const thresholdCalibrationEvents = pgTable(
  'threshold_calibration_event',
  {
    id: id(),
    ownerUserId: owned.ownerUserId(),
    orgId: owned.orgId(),
    trigger: text('trigger').notNull(),
    oldHigh: doublePrecision('old_high').notNull(),
    oldLow: doublePrecision('old_low').notNull(),
    newHigh: doublePrecision('new_high').notNull(),
    newLow: doublePrecision('new_low').notNull(),
    anchorHigh: doublePrecision('anchor_high').notNull(),
    anchorLow: doublePrecision('anchor_low').notNull(),
    windowFrom: timestamp('window_from', { withTimezone: true }),
    windowTo: timestamp('window_to', { withTimezone: true }),
    edge: text('edge'),
    edgeSamples: integer('edge_samples'),
    edgeFailures: integer('edge_failures'),
    reason: text('reason').notNull(),
    /** Within-transaction apply order (r3-Med-5): a two-edge move's events
     * share one transaction timestamp — the ordinal is the deterministic
     * secondary sort so the high→low chain always replays in order. */
    ordinal: integer('ordinal').default(0).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('threshold_calibration_event_owner_created_idx').on(t.ownerUserId, t.createdAt),
    check(
      'threshold_calibration_event_trigger_valid',
      sql`${t.trigger} IN ('calibrator', 'revert', 'rebase')`,
    ),
    check(
      'threshold_calibration_event_edge_valid',
      sql`${t.edge} IS NULL OR ${t.edge} IN ('high', 'low')`,
    ),
  ],
);

/**
 * Semantic-learning sweep audit (add-semantic-learning D8/D9). SCALARS ONLY —
 * by construction NO vector column exists anywhere in the schema (invariant 8);
 * learned centroids live exclusively in Redis. `occurrence_id` is the
 * deterministic idempotency key (`ownerUserId:sweepDay`), globally unique so a
 * crash-retried occurrence appends exactly one row. `trigger`: `apply` advances
 * the generation and refreshes freshness; `discard_revision` records a
 * stale-revision discard (no generation bump, no refresh — D9); `revert` records
 * a user revocation. Drift/similarity are cosine scalars in [0, 2]; `reason` is a
 * numbers-only serialization (never a vector, never a prompt).
 */
export const semanticLearningEvents = pgTable(
  'semantic_learning_event',
  {
    id: id(),
    ownerUserId: owned.ownerUserId(),
    orgId: owned.orgId(),
    occurrenceId: text('occurrence_id').notNull(),
    trigger: text('trigger').notNull(),
    epoch: integer('epoch').notNull(),
    generation: integer('generation').notNull(),
    highSamples: integer('high_samples').default(0).notNull(),
    lowSamples: integer('low_samples').default(0).notNull(),
    highDrift: doublePrecision('high_drift'),
    lowDrift: doublePrecision('low_drift'),
    highSimilarity: doublePrecision('high_similarity'),
    lowSimilarity: doublePrecision('low_similarity'),
    reason: text('reason').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('semantic_learning_event_occurrence_unique').on(t.occurrenceId),
    index('semantic_learning_event_owner_created_idx').on(t.ownerUserId, t.createdAt),
    check(
      'semantic_learning_event_trigger_valid',
      sql`${t.trigger} IN ('apply', 'discard_revision', 'revert')`,
    ),
    check(
      'semantic_learning_event_counts_nonneg',
      sql`${t.highSamples} >= 0 AND ${t.lowSamples} >= 0`,
    ),
    check(
      'semantic_learning_event_drift_finite',
      sql`(${t.highDrift} IS NULL OR (${t.highDrift} >= 0 AND ${t.highDrift} <= 2)) AND (${t.lowDrift} IS NULL OR (${t.lowDrift} >= 0 AND ${t.lowDrift} <= 2))`,
    ),
  ],
);

/** Asynchronous batch jobs (add-batch-inference): the METADATA of a job polyrouter
 * brokered to an upstream batch API. Owned like every owned table (cascade with
 * the owner); `agent_id`/`provider_id`/`model_id`/`tier_assigned` are DENORMALIZED
 * plain ids with no FK — history survives config deletion, the request_log
 * precedent. The shape admits no free-text field: no item body, no result body,
 * and no client-authored `custom_id` (invariant 8). A job maps to its items only
 * through the results stream; each settled item's ledger row names the job
 * (`request_log.batch_id`). Every column past the identity/route block is
 * SYSTEM-owned: written by the submit path, the poller, and settlement — never
 * from caller input. */
export const batchJobs = pgTable(
  'batch_job',
  {
    // Pre-allocated by the submit path: it doubles as the upstream idempotency key,
    // so the row must exist under this id BEFORE the upstream create (D6).
    id: id(),
    ownerUserId: owned.ownerUserId(),
    orgId: owned.orgId(),
    agentId: text('agent_id').notNull(),
    providerId: text('provider_id').notNull(),
    modelId: text('model_id').notNull(),
    tierAssigned: text('tier_assigned'),
    // Null until the upstream create returns (or until reconciliation adopts it).
    upstreamBatchId: text('upstream_batch_id'),
    // The caller's item shape (`/v1/chat/completions` | `/v1/messages`) and the
    // UPSTREAM wire protocol the items were serialized to — snapshotted so results
    // translate exactly as the items were sent, whatever the provider row says later.
    endpoint: text('endpoint').notNull(),
    protocol: text('protocol').notNull(),
    // The serving provider's KIND at submission, snapshotted for the same reason
    // `request_log.provider_kind` is: it decides whether each settled item's cost is
    // money owed or flat-rate notional, and settlement lands up to a day later —
    // reading the provider row then would let a config change reclassify past spend
    // (invariant 4). Null = predates the column.
    providerKind: text('provider_kind'),
    status: text('status').notNull(),
    itemCount: integer('item_count').notNull(),
    completedCount: integer('completed_count').default(0).notNull(),
    failedCount: integer('failed_count').default(0).notNull(),
    // Routing-grade `chars/4` aggregate over every item — a NUMBER, never text; the
    // missing-usage fallback divides it by `item_count` at settlement (D9).
    estimatedInputTokens: integer('estimated_input_tokens').notNull(),
    // The submit-time price snapshot (D7): copied VERBATIM onto every item row at
    // settlement, never re-resolved. Null rates = batch rate unknown (the job was
    // admitted under no `block` budget); the pair and its provenance travel together.
    priceMode: text('price_mode').notNull(),
    inputPriceSnapshot: doublePrecision('input_price_snapshot'),
    outputPriceSnapshot: doublePrecision('output_price_snapshot'),
    cacheReadPriceSnapshot: doublePrecision('cache_read_price_snapshot'),
    cacheWritePriceSnapshot: doublePrecision('cache_write_price_snapshot'),
    priceVersionId: text('price_version_id'),
    priceSource: text('price_source'),
    // The reserved ceiling in integer micro-USD (the spend counter's unit); null =
    // no finite ceiling could be established and no `block` budget applied (D20).
    // The reconciler recomputes `pending` from every non-terminal row's value.
    reservedCeilingMicros: bigint('reserved_ceiling_micros', { mode: 'number' }),
    // Σ of the job's item rows' immutable costs, written at settlement so a
    // terminal job's cost is read here, never re-summed from the ledger (D9).
    settledCostMicros: bigint('settled_cost_micros', { mode: 'number' }),
    // A cancel recorded before an upstream id existed; honoured by the reconciler
    // the moment an id is adopted (D6).
    cancelRequested: boolean('cancel_requested').default(false).notNull(),
    // The provider's completion window, as declared by the adapter at submission;
    // local expiry = submitted_at + window + BATCH_WINDOW_MARGIN_MS, and even then
    // the job is not terminal until the upstream confirms (D21).
    completionWindowMs: integer('completion_window_ms').notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    // When the job entered a state that needs an operator after a bound —
    // `submission_unknown`, or an unmapped upstream status; cleared on recovery.
    stalledSince: timestamp('stalled_since', { withTimezone: true }),
    terminalAt: timestamp('terminal_at', { withTimezone: true }),
    // The upstream's results retention deadline; null = the adapter reported none
    // (the UI says "retention unknown" rather than inventing a date, D23).
    resultsExpireAt: timestamp('results_expire_at', { withTimezone: true }),
    errorKind: text('error_kind'),
  },
  (t) => [
    index('batch_job_owner_idx').on(t.ownerUserId),
    index('batch_job_owner_submitted_idx').on(t.ownerUserId, t.submittedAt),
    // The poller's sweep reads only non-terminal rows, which stay few while the
    // terminal population only grows — a partial index keeps the sweep cheap.
    index('batch_job_active_idx')
      .on(t.updatedAt)
      .where(
        sql`${t.status} NOT IN (${sql.raw(BATCH_JOB_TERMINAL_STATUSES.map((s) => `'${s}'`).join(', '))})`,
      ),
    check(
      'batch_job_status_valid',
      sql`${t.status} IN (${sql.raw(BATCH_JOB_STATUSES.map((s) => `'${s}'`).join(', '))})`,
    ),
    check(
      'batch_job_endpoint_valid',
      sql`${t.endpoint} IN (${sql.raw(BATCH_ENDPOINTS.map((s) => `'${s}'`).join(', '))})`,
    ),
    check(
      'batch_job_protocol_valid',
      sql`${t.protocol} IN ('openai_compatible', 'anthropic_compatible', 'openai_responses')`,
    ),
    // The same closed vocabulary `request_log.provider_kind` carries, for the same
    // reason: the spend classification partitions on this value.
    check(
      'batch_job_provider_kind_known',
      sql`${t.providerKind} IS NULL OR ${t.providerKind} IN ('api_key','subscription','custom','local')`,
    ),
    check('batch_job_item_count_positive', sql`${t.itemCount} > 0`),
    check(
      'batch_job_counts_bounded',
      sql`${t.completedCount} >= 0 AND ${t.failedCount} >= 0 AND ${t.completedCount} + ${t.failedCount} <= ${t.itemCount}`,
    ),
    check('batch_job_estimated_tokens_nonneg', sql`${t.estimatedInputTokens} >= 0`),
    check('batch_job_price_mode_valid', sql`${t.priceMode} IN ('sync', 'batch')`),
    // The rate pair and its provenance are present together or absent together.
    check(
      'batch_job_price_pair',
      sql`(${t.inputPriceSnapshot} IS NULL) = (${t.outputPriceSnapshot} IS NULL) AND (${t.inputPriceSnapshot} IS NULL) = (${t.priceSource} IS NULL)`,
    ),
    // Batch mode never resolves a model-own or local price (pricing-catalog).
    check(
      'batch_job_price_source_valid',
      sql`${t.priceSource} IS NULL OR ${t.priceSource} IN ('bundled', 'refresh', 'manual', 'native_family', 'listed')`,
    ),
    check(
      'batch_job_reserved_nonneg',
      sql`${t.reservedCeilingMicros} IS NULL OR ${t.reservedCeilingMicros} >= 0`,
    ),
    check(
      'batch_job_settled_nonneg',
      sql`${t.settledCostMicros} IS NULL OR ${t.settledCostMicros} >= 0`,
    ),
    check('batch_job_completion_window_positive', sql`${t.completionWindowMs} > 0`),
    check(
      'batch_job_error_kind_valid',
      sql`${t.errorKind} IS NULL OR ${t.errorKind} IN (${sql.raw(BATCH_JOB_ERROR_KINDS.map((s) => `'${s}'`).join(', '))})`,
    ),
    // A terminal row stamps when it became terminal; a live row carries no stamp.
    check(
      'batch_job_terminal_at_pair',
      sql`(${t.terminalAt} IS NULL) = (${t.status} NOT IN (${sql.raw(BATCH_JOB_TERMINAL_STATUSES.map((s) => `'${s}'`).join(', '))}))`,
    ),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type AccountRow = typeof accounts.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type ProviderRow = typeof providers.$inferSelect;
export type ModelRow = typeof models.$inferSelect;
export type TierRow = typeof tiers.$inferSelect;
export type RoutingEntryRow = typeof routingEntries.$inferSelect;
export type RoutingRuleRow = typeof routingRules.$inferSelect;
export type ModelPriceRow = typeof modelPrices.$inferSelect;
export type RequestLogRow = typeof requestLogs.$inferSelect;
export type RequestAttemptRow = typeof requestAttempts.$inferSelect;
export type NotificationChannelRow = typeof notificationChannels.$inferSelect;
export type BudgetRow = typeof budgets.$inferSelect;
export type RoutingSettingsRow = typeof routingSettings.$inferSelect;
export type BodyCaptureSettingsRow = typeof bodyCaptureSettings.$inferSelect;
export type RequestBodyRow = typeof requestBodies.$inferSelect;
export type PricingRefreshRunRow = typeof pricingRefreshRuns.$inferSelect;
export type ThresholdCalibrationEventRow = typeof thresholdCalibrationEvents.$inferSelect;
export type SemanticLearningEventRow = typeof semanticLearningEvents.$inferSelect;
export type BatchJobRow = typeof batchJobs.$inferSelect;
export type InviteRow = typeof invites.$inferSelect;
export type InstanceSettingsRow = typeof instanceSettings.$inferSelect;
