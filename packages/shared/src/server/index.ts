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
  OwnedRepository,
  PersistenceFacilities,
  PersistencePort,
  ProviderInsertInput,
  ProviderPatch,
  RoutingEntryAccessor,
  RoutingRuleInsertInput,
  RoutingRulePatch,
  TierInsertInput,
  TierPatch,
  UsersInfra,
} from './persistence';
export { decryptSecret, encryptSecret } from './security/encryption';
