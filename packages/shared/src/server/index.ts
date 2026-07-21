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
  AnalyticsAccessor,
  AnalyticsBreakdownRow,
  AutoCounterfactualRates,
  AutoPerformanceData,
  AutoSavingsTotals,
  AnalyticsBucket,
  AnalyticsDimension,
  AnalyticsRange,
  AnalyticsRequestRow,
  AnalyticsRequestsCursor,
  AnalyticsRequestsPage,
  AnalyticsRequestsQuery,
  AnalyticsSummary,
  AnalyticsTimeseriesPoint,
  BodyCaptureAccessor,
  BodyCaptureContext,
  BodyCaptureMode,
  BodyCaptureOverride,
  BodyCaptureSettingsUpsert,
  BodyCaptureSettingsValue,
  RequestBodyInsertItem,
  RequestBodyView,
  BudgetInsertInput,
  BudgetPatch,
  ModelAccessor,
  ModelInsertInput,
  ModelPatch,
  ModelPriceInput,
  NotificationChannelInsertInput,
  NotificationChannelPatch,
  OwnedRepository,
  PersistenceFacilities,
  PersistencePort,
  PricingCatalog,
  ProviderInsertInput,
  ProviderPatch,
  ReplaceEntriesResult,
  RequestAttemptAccessor,
  RequestAttemptInsertInput,
  RequestLogAccessor,
  RequestLogInsertInput,
  RoutingEntryAccessor,
  RoutingSettingsAccessor,
  RoutingSettingsUpsert,
  RoutingSettingsValue,
  CalibratedQuad,
  CalibrationExpectedState,
  CalibrationSweepTenant,
  CalibrationEdgeStats,
  PricingRefreshRunInput,
  PricingStatusMeta,
  CalibrationEventsAccessor,
  ThresholdCalibrationEventInput,
  ThresholdCalibrationEventRowView,
  RoutingRuleInsertInput,
  RoutingRulePatch,
  TierInsertInput,
  TierPatch,
  UsersInfra,
} from './persistence';
export {
  AGGREGATOR_FAMILIES,
  AGGREGATOR_VENDOR_FAMILIES,
  PROVIDER_FAMILY_HOSTS,
  canonicalModelKey,
  deriveModelKey,
  deriveNativeFamilyKey,
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
} from '../routing-constants';
export type { RuleMatchType } from '../routing-constants';
// Re-exported verbatim from the shared ROOT (add-band-target-ui): the pure
// target helpers are browser-safe and the dashboard needs the CANONICAL
// parser — one source of truth, no server-side churn.
export { formatRoutingTarget, parseRoutingTarget } from '../routing-target';
export type { RoutingTarget } from '../routing-target';
export { decryptSecret, encryptSecret } from './security/encryption';
export {
  POLYCRED_MARKER,
  TamperedCredentialError,
  credentialLockKey,
  parseCredentialEnvelope,
  resolvePlainCredentialValue,
  serializeOauthCredential,
  serializePlainCredential,
} from './security/credential-envelope';
export type { OauthCredential, ParsedCredential } from './security/credential-envelope';
export {
  SsrfError,
  classifyIp,
  isBlockedIp,
  isAddressPermitted,
  assertEndpointsSafe,
  assertUrlSafe,
  createGuardedDispatcher,
  dispatcherTimeoutOptions,
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
export { assertNetworkHostSafe } from './security/network-host';
export type { NetworkHostOptions } from './security/network-host';
export {
  assertAppriseTargetSafe,
  APPRISE_HOST_BEARING_SCHEMES,
  APPRISE_FIXED_SERVICE_SCHEMES,
} from './security/apprise';
export {
  AUTH_ADAPTER_FACTORY,
  BOOTSTRAP_LOCK,
  FIRST_ADMIN_LOCK,
  IDENTITY_PORT,
  INSTANCE_SETTINGS_ID,
  REGISTRATION_MODES,
} from './identity';
export type {
  AdminInviteRecord,
  AdminUserRecord,
  AgentAuthAccessor,
  AgentAuthRecord,
  AuthAdapterFactory,
  IdentityPort,
  RegistrationMode,
  UserAdminAccessor,
} from './identity';
