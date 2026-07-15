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
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('user_email_unique').on(t.email)],
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
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('agent_api_key_prefix_unique').on(t.apiKeyPrefix),
    index('agent_owner_idx').on(t.ownerUserId),
  ],
);

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
    createdAt: createdAt(),
  },
  (t) => [index('provider_owner_idx').on(t.ownerUserId)],
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
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cacheReadTokens: integer('cache_read_tokens'),
    cacheWriteTokens: integer('cache_write_tokens'),
    inputPriceSnapshot: doublePrecision('input_price_snapshot'),
    outputPriceSnapshot: doublePrecision('output_price_snapshot'),
    cacheReadPriceSnapshot: doublePrecision('cache_read_price_snapshot'),
    cacheWritePriceSnapshot: doublePrecision('cache_write_price_snapshot'),
    priceVersionId: text('price_version_id'),
    usageEstimated: boolean('usage_estimated').default(false).notNull(),
    cost: doublePrecision('cost'),
    durationMs: integer('duration_ms').notNull(),
    status: text('status').notNull(), // success | error (fallback/escalated: #12/#13)
    escalated: boolean('escalated').default(false).notNull(),
    qualitySignal: doublePrecision('quality_signal'),
    createdAt: createdAt(),
  },
  (t) => [
    index('request_log_created_idx').on(t.createdAt),
    index('request_log_owner_idx').on(t.ownerUserId),
    index('request_log_agent_idx').on(t.agentId),
    index('request_log_provider_idx').on(t.providerId),
    index('request_log_model_idx').on(t.modelId),
    check(
      'request_log_tokens_nonneg',
      sql`${t.inputTokens} >= 0 AND ${t.outputTokens} >= 0
        AND (${t.cacheReadTokens} IS NULL OR ${t.cacheReadTokens} >= 0)
        AND (${t.cacheWriteTokens} IS NULL OR ${t.cacheWriteTokens} >= 0)`,
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
