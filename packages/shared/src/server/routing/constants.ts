/** Routing-config constants shared by the management API (#9) and the proxy
 * (#10) so both sides agree on keys, the tier header, and the fallback cap.
 * Pure — no DB, no clock, no network. */

/** The always-present, seeded tier every tenant has (spec §5). */
export const DEFAULT_TIER_KEY = 'default';

/** Default header a `header` RoutingRule matches on to force a tier (spec §7.2).
 * Stored lower-cased; HTTP header names are case-insensitive. */
export const TIER_HEADER_NAME = 'x-polyrouter-tier';

/** The opt-in automatic-routing alias (spec §2, §6.1). Reserved — it can never
 * be a user-defined tier key, so it cannot shadow the alias. */
export const AUTO_ALIAS = 'auto';

/** Max ordered models in a tier's fallback chain (spec §7.4). Mirrors the
 * `routing_entry.position BETWEEN 0 AND 4` CHECK — positions `0..4`. */
export const MAX_MODELS_PER_TIER = 5;

/** A tier key is a lowercase slug (1–64 chars): starts alphanumeric, then
 * alphanumerics / `-` / `_`. Keeps keys safe as header values and stable ids. */
export const TIER_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,63})$/;

/** Valid `header` rule match types (spec §5). */
export const RULE_MATCH_TYPES = ['header', 'default'] as const;
export type RuleMatchType = (typeof RULE_MATCH_TYPES)[number];
