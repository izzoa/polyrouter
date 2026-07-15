/**
 * Public surface of the Layer-0 routing engine (#10). Pure resolution over an
 * owned config snapshot; consumed by the control-plane proxy service.
 */
export { resolveRoute, isRouteError, resolveTarget, ruleOrder } from './resolve';
export * from './structural';
export type {
  RoutingSnapshot,
  ParsedRoute,
  RouteTier,
  RouteEntry,
  RouteRule,
  RouteModel,
  RouteTarget,
  RouteDecision,
  RouteError,
  RouteErrorKind,
  DecisionLayer,
} from './resolve';
