/**
 * Pure Layer-0 route resolution (#10, spec §6.1/§7.2). Given an owned config
 * snapshot + the request's model field and headers, decide the concrete
 * provider+model — or return a typed error. No DB, no Nest, no clock, no I/O;
 * the proxy (control-plane) loads the snapshot and acts on the decision.
 */
import {
  AUTO_ALIAS,
  DEFAULT_TIER_KEY,
  TIER_HEADER_NAME,
  parseRoutingTarget,
} from '@polyrouter/shared/server';

export interface RouteTier {
  readonly id: string;
  readonly key: string;
}
export interface RouteEntry {
  readonly modelId: string;
  readonly position: number;
}
export interface RouteRule {
  readonly id: string;
  readonly matchType: string;
  readonly headerName: string;
  readonly headerValue: string | null;
  readonly target: string;
  readonly priority: number;
  readonly createdAt: Date;
}
export interface RouteModel {
  readonly id: string;
  readonly providerId: string;
  readonly externalModelId: string;
}

export interface RoutingSnapshot {
  readonly tiers: readonly RouteTier[];
  /** Ordered entries per tier id (any order — the resolver selects position 0). */
  readonly entriesByTierId: ReadonlyMap<string, readonly RouteEntry[]>;
  readonly rules: readonly RouteRule[];
  readonly models: readonly RouteModel[];
}

/** Headers with LOWER-CASED keys (HTTP header names are case-insensitive). */
export interface ParsedRoute {
  readonly modelField: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export type DecisionLayer = 'explicit' | 'header' | 'default';

export interface RouteDecision {
  readonly providerId: string;
  readonly modelId: string;
  readonly externalModelId: string;
  /** The resolved tier key, or null for a directly-named model (#11 tier_assigned). */
  readonly tierKey: string | null;
  readonly decisionLayer: DecisionLayer;
  readonly routingReason: string;
}

export type RouteErrorKind =
  'unknown_model' | 'ambiguous_model' | 'empty_tier' | 'unresolved_target' | 'no_default';

export interface RouteError {
  readonly error: RouteErrorKind;
  readonly detail?: string;
}

export function isRouteError(r: RouteDecision | RouteError): r is RouteError {
  return 'error' in r;
}

function modelDecision(
  model: RouteModel,
  decisionLayer: DecisionLayer,
  routingReason: string,
  tierKey: string | null = null,
): RouteDecision {
  return {
    providerId: model.providerId,
    modelId: model.id,
    externalModelId: model.externalModelId,
    tierKey,
    decisionLayer,
    routingReason,
  };
}

function resolveTier(
  snap: RoutingSnapshot,
  tier: RouteTier,
  layer: DecisionLayer,
  reason: string,
): RouteDecision | RouteError {
  // The primary is position 0 exactly (walking a fallback chain is #12); if a
  // model/provider cascade removed position 0, treat the tier as unusable here
  // rather than silently promoting a fallback.
  const primary = (snap.entriesByTierId.get(tier.id) ?? []).find((e) => e.position === 0);
  if (!primary) return { error: 'empty_tier', detail: tier.key };
  const model = snap.models.find((m) => m.id === primary.modelId);
  // FK guarantees the model exists; guard defensively as an unresolved target.
  if (!model) return { error: 'unresolved_target', detail: tier.key };
  return modelDecision(model, layer, reason, tier.key);
}

function resolveTarget(
  snap: RoutingSnapshot,
  target: string,
  layer: DecisionLayer,
  reason: string,
): RouteDecision | RouteError {
  const parsed = parseRoutingTarget(target);
  if (!parsed) return { error: 'unresolved_target', detail: target };
  if (parsed.kind === 'tier') {
    const tier = snap.tiers.find((t) => t.key === parsed.key);
    if (!tier) return { error: 'unresolved_target', detail: target };
    return resolveTier(snap, tier, layer, reason);
  }
  const model = snap.models.find((m) => m.id === parsed.id);
  if (!model) return { error: 'unresolved_target', detail: target };
  return modelDecision(model, layer, reason);
}

const ruleOrder = (a: RouteRule, b: RouteRule): number =>
  b.priority - a.priority ||
  a.createdAt.getTime() - b.createdAt.getTime() ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function resolveRoute(
  snap: RoutingSnapshot,
  parsed: ParsedRoute,
): RouteDecision | RouteError {
  const mf = parsed.modelField;

  // Phase 1 — an explicit selection in the `model` field terminates here.
  if (mf.length > 0 && mf !== AUTO_ALIAS) {
    // provider-qualified "<providerId>:<externalId>" (providerId is a UUID → no colon)
    const colon = mf.indexOf(':');
    if (colon > 0) {
      const providerId = mf.slice(0, colon);
      const externalModelId = mf.slice(colon + 1);
      const qualified = snap.models.find(
        (m) => m.providerId === providerId && m.externalModelId === externalModelId,
      );
      if (qualified)
        return modelDecision(qualified, 'explicit', `explicit model ${externalModelId}`);
      // else: the colon was part of a bare model id — fall through.
    }
    // bare external id
    const matches = snap.models.filter((m) => m.externalModelId === mf);
    if (matches.length === 1) return modelDecision(matches[0]!, 'explicit', `explicit model ${mf}`);
    if (matches.length > 1) return { error: 'ambiguous_model', detail: mf };
    // tier key (a name that is both a model and a tier resolved to the model above)
    const tier = snap.tiers.find((t) => t.key === mf);
    if (tier) return resolveTier(snap, tier, 'explicit', `explicit tier ${mf}`);
    // non-empty, unrecognized → a clear error, never a silent default
    return { error: 'unknown_model', detail: mf };
  }

  // Phase 1 made no selection (empty or `auto`): fall through to header/default.
  const rules = [...snap.rules].sort(ruleOrder);

  // Phase 2 — a matching custom `header` rule.
  for (const r of rules) {
    if (r.matchType !== 'header' || r.headerValue === null) continue;
    if (parsed.headers[r.headerName.toLowerCase()] === r.headerValue) {
      return resolveTarget(snap, r.target, 'header', `header rule ${r.headerName}`);
    }
  }

  // Phase 3 — the built-in `x-polyrouter-tier` header naming an owned tier
  // (before default rules, so it forces a tier even when a default rule exists).
  const builtin = parsed.headers[TIER_HEADER_NAME];
  if (builtin !== undefined && builtin.length > 0) {
    const tier = snap.tiers.find((t) => t.key === builtin);
    if (tier) return resolveTier(snap, tier, 'header', `${TIER_HEADER_NAME}: ${builtin}`);
    // a header naming a missing tier is advisory — fall through to default.
  }

  // Phase 4 — a `default`-match rule.
  for (const r of rules) {
    if (r.matchType === 'default') {
      return resolveTarget(snap, r.target, 'default', 'default rule');
    }
  }

  // Phase 5 — the seeded `default` tier.
  const def = snap.tiers.find((t) => t.key === DEFAULT_TIER_KEY);
  if (!def) return { error: 'no_default' };
  return resolveTier(
    snap,
    def,
    'default',
    mf === AUTO_ALIAS ? 'auto → default tier' : 'default tier',
  );
}
