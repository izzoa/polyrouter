/** Server-only entrypoint (`@polyrouter/shared/server`): database schema,
 * tenancy primitives, the persistence seam, and encryption. Importable by
 * `control-plane` and `data-plane`; forbidden to `frontend` by the boundary
 * lint. Never re-export anything from here through the root entrypoint. */

export * from './db/schema';
export { assertUserPrincipal, ownershipPredicate, userPrincipal } from './tenancy';
export type { OwnedTableColumns, Principal } from './tenancy';
export { PERSISTENCE_FACILITIES, PERSISTENCE_PORT, REDIS_CLIENT } from './persistence';
export type {
  AgentInsertInput,
  AgentPatch,
  ModelAccessor,
  ModelInsertInput,
  ModelPatch,
  ModelPriceInput,
  OwnedRepository,
  PersistenceFacilities,
  PersistencePort,
  PricingCatalog,
  ProviderInsertInput,
  ProviderPatch,
  ReplaceEntriesResult,
  RoutingEntryAccessor,
  RoutingRuleInsertInput,
  RoutingRulePatch,
  TierInsertInput,
  TierPatch,
  UsersInfra,
} from './persistence';
export {
  PROVIDER_FAMILY_HOSTS,
  canonicalModelKey,
  deriveModelKey,
  resolveModelPrice,
} from './pricing/resolve';
export type {
  BundledPrice,
  PriceResolutionInput,
  PriceSnapshot,
  PriceSource,
} from './pricing/resolve';
export { parseLiteLlmCatalog } from './pricing/litellm';
export {
  AUTO_ALIAS,
  DEFAULT_TIER_KEY,
  MAX_MODELS_PER_TIER,
  RULE_MATCH_TYPES,
  TIER_HEADER_NAME,
  TIER_KEY_PATTERN,
} from './routing/constants';
export type { RuleMatchType } from './routing/constants';
export { formatRoutingTarget, parseRoutingTarget } from './routing/target';
export type { RoutingTarget } from './routing/target';
export { decryptSecret, encryptSecret } from './security/encryption';
export {
  SsrfError,
  classifyIp,
  isBlockedIp,
  isAddressPermitted,
  assertUrlSafe,
  createGuardedDispatcher,
  guardedFetch,
} from './security/ssrf';
export type {
  AllowedEndpoint,
  GuardContext,
  IpClass,
  IsBlockedOptions,
  SsrfCode,
  UrlGuardOptions,
} from './security/ssrf';
export { AUTH_ADAPTER_FACTORY, FIRST_ADMIN_LOCK, IDENTITY_PORT } from './identity';
export type {
  AgentAuthAccessor,
  AgentAuthRecord,
  AuthAdapterFactory,
  IdentityPort,
} from './identity';
