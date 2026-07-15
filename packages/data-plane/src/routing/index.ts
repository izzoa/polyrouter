/**
 * Public surface of the Layer-0 routing engine (#10). Pure resolution over an
 * owned config snapshot; consumed by the control-plane proxy service.
 */
export { resolveRoute, isRouteError } from './resolve';
export type {
  RoutingSnapshot,
  ParsedRoute,
  RouteTier,
  RouteEntry,
  RouteRule,
  RouteModel,
  RouteDecision,
  RouteError,
  RouteErrorKind,
  DecisionLayer,
} from './resolve';
