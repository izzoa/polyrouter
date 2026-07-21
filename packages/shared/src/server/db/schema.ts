import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

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
    // Provider-listed price captured at sync as a DISPLAY-ONLY estimate
    // (add-provider-price-sync-and-edit). Deliberately DISTINCT from the user-price
    // columns above: these NEVER feed `resolveModelPrice`, the `model_prices` catalog,
    // or the request-time cost snapshot (invariant 4 — recorded cost comes from the
    // bundled catalog, not provider `/models`). Per-provider; rewritten on every sync
    // (set from the listed price, or cleared to null when none is listed); cleared on a
    // base_url/protocol change. `listed_is_free` is null when no estimate exists and is
    // true only when every monetary dimension the provider lists is zero.
    listedInputPricePer1m: doublePrecision('listed_input_price_per_1m'),
    listedOutputPricePer1m: doublePrecision('listed_output_price_per_1m'),
    listedIsFree: boolean('listed_is_free'),
    listedPriceCapturedAt: timestamp('listed_price_captured_at', { withTimezone: true }),
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
  },
  (t) => [
    uniqueIndex('routing_entry_tier_position_unique').on(t.tierId, t.position),
    index('routing_entry_tier_idx').on(t.tierId),
    check('routing_entry_position_range', sql`${t.position} BETWEEN 0 AND 4`),
  ],
);

export const routingRules = pgTable(
  'routing_rule',
  {
    id: id(),
    ownerUserId: owned.ownerUserId(),
    orgId: owned.orgId(),
    matchType: text('match_type').notNull(), // header | default
    headerName: text('header_name').default('x-polyrouter-tier').notNull(),
    headerValue: text('header_value'),
    target: text('target').notNull(),
    priority: integer('priority').default(0).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('routing_rule_owner_idx').on(t.ownerUserId)],
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
    supportsTools: boolean('supports_tools').default(false).notNull(),
    supportsVision: boolean('supports_vision').default(false).notNull(),
    supportsReasoning: boolean('supports_reasoning').default(false).notNull(),
    isFree: boolean('is_free').default(false).notNull(),
    source: text('source').notNull(), // bundled | refresh | manual
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('model_price_key_valid_from_unique').on(t.modelKey, t.validFrom),
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
    // on decision_layer='header' rows. Built-in x-polyrouter-tier records name +
    // the matched OWNED tier key; a custom rule records its normalized name with
    // a NULL value (a configured header_value can itself be a credential — never
    // persisted). Null = other layers or rows predating the columns.
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
    // Terminal provider-error detail (add-request-error-detail): set ONLY on
    // status='error' rows; null for non-error rows and rows predating capture
    // (unknown-not-wrong, never backfilled). `error_message` is the factory-
    // sanitized provider-verbatim text (≤300); `error_request_id` allowlisted.
    errorKind: text('error_kind'),
    errorStatus: integer('error_status'),
    errorMessage: text('error_message'),
    errorRequestId: text('error_request_id'),
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
    // Provenance is binary and only ever on escalated rows (fail-closed).
    check(
      'request_log_escalation_source_valid',
      sql`${t.escalationSource} IS NULL OR (${t.escalationSource} IN ('quality_gate', 'cheap_error') AND ${t.escalated})`,
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
export type InviteRow = typeof invites.$inferSelect;
export type InstanceSettingsRow = typeof instanceSettings.$inferSelect;
