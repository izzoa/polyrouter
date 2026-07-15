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
 * `role` is nullable for Better Auth's admin plugin (first user = admin, #3). */
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

export type UserRow = typeof users.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type ProviderRow = typeof providers.$inferSelect;
export type ModelRow = typeof models.$inferSelect;
export type TierRow = typeof tiers.$inferSelect;
export type RoutingEntryRow = typeof routingEntries.$inferSelect;
export type RoutingRuleRow = typeof routingRules.$inferSelect;
