/**
 * Public surface of the Layer-0 routing engine (#10). Pure resolution over an
 * owned config snapshot; consumed by the control-plane proxy service.
 */
export {
  resolveRoute,
  isRouteError,
  resolveTarget,
  ruleOrder,
  resolveBandTarget,
  resolveWorkloadTarget,
  DECISION_LAYERS,
} from './resolve';
export * from './structural';
export type {
  RoutingSnapshot,
  ParsedRoute,
  RouteTier,
  RouteEntry,
  RouteRule,
  RouteModel,
  RouteTarget,
  MatchedHeader,
  RouteDecision,
  RouteError,
  RouteErrorKind,
  DecisionLayer,
} from './resolve';
export type {
  SemanticWorkloadVerdict,
  SemanticWorkloadVerdictClass,
  StructuralWorkloadVerdict,
} from './workload-verdict';
