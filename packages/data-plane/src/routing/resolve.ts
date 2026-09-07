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
  isNonRoutableVariant,
  parseModelVariant,
  parseRoutingTarget,
} from '@polyrouter/shared/server';

export interface RouteTier {
  readonly id: string;
  readonly key: string;
}
export interface RouteEntry {
  readonly modelId: string;
  readonly position: number;
  /** Which execution mode this entry is reserved for (add-batch-mode-routing).
   * REQUIRED, like `RouteModel.variant` and for the same reason: a snapshot
   * builder or fixture omitting an optional field would silently make every
   * entry unreserved, restoring the synchronous use of capacity a tenant
   * deliberately set aside. */
  readonly mode: EntryMode;
}

/** `any` = no restriction (what every entry predating the field is). `batch` =
 * reserved for batch work: excluded from a synchronous walk, preferred by a
 * batch submission. */
export type EntryMode = 'any' | 'batch';

/** Which mode a resolution is FOR. Absent means synchronous — the batch path
 * passes it explicitly, because a resolver that applied the synchronous
 * reservation exclusion to a batch would answer `empty_tier` for the one
 * configuration a batch is entitled to use (add-batch-mode-routing D13). */
export type ResolutionMode = 'sync' | 'batch';
export interface RouteRule {
  readonly id: string;
  readonly matchType: string;
  readonly headerName: string;
  readonly headerValue: string | null;
  /** The workload class an `auto_workload` rule binds (add-workload-routing),
   * or the class SCOPE of an `auto_high`/`auto_low` band rule (add-workload-
   * scoped-bands); null = a generic (unscoped) band rule / every other match
   * type. Optional so pre-existing snapshots and fixtures stay valid. */
  readonly workloadClass?: string | null;
  readonly target: string;
  readonly priority: number;
  readonly createdAt: Date;
}
export interface RouteModel {
  readonly id: string;
  readonly providerId: string;
  readonly externalModelId: string;
  /** Derived aggregator SKU variant (add-model-variant-detection); null = none.
   * REQUIRED-nullable on purpose: an optional field omitted by a snapshot builder
   * or a fixture would silently restore routability to a model that cannot serve. */
  readonly variant: string | null;
}

/** A model no request can be sent to (today: a batch-priced twin). Chains exclude
 * these members; explicit asks are refused by name rather than rerouted. */
function isRoutable(m: RouteModel): boolean {
  return !isNonRoutableVariant(m.variant);
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
  /** Defaults to `sync`; the batch path sets `batch`. */
  readonly mode?: ResolutionMode;
}

export type DecisionLayer =
  'explicit' | 'header' | 'default' | 'structural' | 'cascade' | 'semantic' | 'workload';

/** The complete decision-layer value list (add-semantic-routing): the one
 * source the analytics `layer` filter validates against per-element. */
export const DECISION_LAYERS: readonly DecisionLayer[] = [
  'explicit',
  'header',
  'default',
  'structural',
  'cascade',
  'semantic',
  'workload',
];

/** One member of a fallback chain (#12). */
export interface RouteTarget {
  readonly providerId: string;
  readonly modelId: string;
  readonly externalModelId: string;
}

/** The header that CHOSE the route (add-routing-header-visibility). `value` is
 * the matched OWNED config string, never raw client bytes, and only for the
 * `x-polyrouter-tier` header (a routing-category selector, record-tier-header-value):
 * a direct tier lookup carries the matched tier key (already recorded as
 * tier_assigned), a tier-header remap carries the matched rule's header_value
 * (the tier-ask category). A rule on ANY OTHER header carries its normalized name
 * with a null value — a configured header_value there can itself be a credential
 * ("never log secrets", fail-closed, no denylist). */
export interface MatchedHeader {
  readonly name: string;
  readonly value: string | null;
}

export interface RouteDecision {
  readonly providerId: string;
  readonly modelId: string;
  readonly externalModelId: string;
  /** The resolved tier key, or null for a directly-named model (#11 tier_assigned). */
  readonly tierKey: string | null;
  readonly decisionLayer: DecisionLayer;
  readonly routingReason: string;
  /** The class of the CLASS-SCOPED band rule that decided (add-workload-
   * scoped-bands) — carried as DATA, never inside `routingReason`: the proxy
   * appends ` scope=<class>` as the TERMINAL fragment of the recorded reason
   * (after any quality marker, fall-back trail, capacity note, or
   * classification trail). Absent on generic band decisions and every other
   * layer. */
  readonly scope?: string;
  /** Non-null ONLY for `header`-layer decisions; null everywhere else, including
   * the advisory fall-through (a non-matching client value is never captured). */
  readonly matchedHeader: MatchedHeader | null;
  /** The ordered fallback chain (#12); `chain[0]` is the primary (= the fields
   * above). A tier resolves to all its entries in position order; a direct model
   * to a single-element chain. */
  readonly chain: readonly RouteTarget[];
}

export type RouteErrorKind =
  | 'unknown_model'
  | 'ambiguous_model'
  | 'empty_tier'
  | 'unresolved_target'
  | 'no_default'
  | 'batch_only_model';

export interface RouteError {
  readonly error: RouteErrorKind;
  readonly detail?: string;
  /** `batch_only_model` only: the base id derived from the asked-for model, and
   * whether a ROUTABLE model bearing it exists on the SAME provider. The renderer
   * offers it as an alternative only when it does — the router never promises a
   * route it does not have. Derived from owned config, never from client bytes. */
  readonly baseModelId?: string;
  readonly baseIsRoutable?: boolean;
}

/** Build the refusal for an explicit ask that landed on a non-routable model. */
function batchOnlyError(snap: RoutingSnapshot, model: RouteModel): RouteError {
  const parsed = parseModelVariant(model.externalModelId);
  if (parsed === null) return { error: 'batch_only_model', detail: model.externalModelId };
  const sibling = snap.models.find(
    (m) => m.providerId === model.providerId && m.externalModelId === parsed.base,
  );
  return {
    error: 'batch_only_model',
    detail: model.externalModelId,
    baseModelId: parsed.base,
    baseIsRoutable: sibling !== undefined && isRoutable(sibling),
  };
}

export function isRouteError(r: RouteDecision | RouteError): r is RouteError {
  return 'error' in r;
}

function target(model: RouteModel): RouteTarget {
  return {
    providerId: model.providerId,
    modelId: model.id,
    externalModelId: model.externalModelId,
  };
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
    matchedHeader: null, // only resolveRoute's header phases override
    chain: [target(model)], // a directly-named model has no fallback
  };
}

function resolveTier(
  snap: RoutingSnapshot,
  tier: RouteTier,
  layer: DecisionLayer,
  reason: string,
  mode: ResolutionMode = 'sync',
): RouteDecision | RouteError {
  // Primary is position 0 exactly (if a cascade removed it, the tier is unusable
  // here rather than silently promoting a fallback). The chain is all resolvable
  // entries in position order (#12), chain[0] = the position-0 primary.
  //
  // ONE stated exception (add-model-variant-detection): an entry whose model is
  // NON-ROUTABLE by variant is dropped BEFORE the position-0 rule, because it
  // could never serve — so `[twin@0, base@1]`, which works today only by spending
  // a failed upstream attempt, promotes `base` instead of breaking. This is not
  // the no-silent-promotion case: that rule protects a DELETED position-0 entry
  // (a config accident), whereas a twin is a row we can prove is unservable.
  const all = [...(snap.entriesByTierId.get(tier.id) ?? [])].sort(
    (a, b) => a.position - b.position,
  );
  const modelById = (id: string): RouteModel | undefined => snap.models.find((m) => m.id === id);
  const nonRoutable = (e: RouteEntry): boolean => {
    const m = modelById(e.modelId);
    return m !== undefined && !isRoutable(m);
  };
  // A SECOND exclusion (add-batch-mode-routing): an entry RESERVED for batch cannot
  // serve a synchronous request either, so it drops before the position-0 rule on
  // exactly the same terms. Counted separately from the non-routable exclusion —
  // reporting a tenant's deliberate reservation as "batch-only" would describe
  // their configuration as a catalog defect.
  //
  // A BATCH resolution applies neither this exclusion nor a preference for the
  // unreserved: it selects ONE candidate below, so the reservation is what claims
  // batch rather than something the chain composition has to encode.
  const reserved = (e: RouteEntry): boolean => mode === 'sync' && e.mode === 'batch';
  const excludedVariant = all.filter((e) => nonRoutable(e) && !reserved(e)).length;
  const excludedReserved = all.filter(reserved).length;
  const dropped = (e: RouteEntry): boolean => nonRoutable(e) || reserved(e);
  const entries = all.filter((e) => !dropped(e));
  // Promotion is justified ONLY by an exclusion. A position-0 entry that is simply
  // MISSING (deleted, or removed by a cascade) still errors, exactly as before —
  // otherwise an unrelated non-routable member elsewhere in the chain would quietly
  // buy a promotion the no-silent-promotion rule exists to forbid.
  const atZero = all.find((e) => e.position === 0);
  const primary =
    mode === 'batch'
      ? // ONE candidate, never promoted (add-batch-mode-routing D3): the
        // lowest-position RESERVED entry when the chain holds any, else position 0.
        // "Holds any" is literal — a reservation that turns out to be unserviceable
        // does not fall back to unreserved capacity, because a later member can be
        // a different provider at a different price and moving bulk work onto
        // billable capacity the tenant did not name is not the router's call.
        //
        // Routability is NOT filtered into this choice, deliberately: a candidate
        // that is non-routable by variant is REFUSED BY NAME below rather than
        // skipped, the same way an explicit ask for a twin is refused. Filtering it
        // here would either dispatch the twin's id upstream (a chain can still hold
        // one — classification never rewrites a stored entry) or mislabel a tier
        // that does hold an entry as `empty_tier`.
        (all.find((e) => e.mode === 'batch') ?? atZero)
      : atZero === undefined
        ? undefined
        : dropped(atZero)
          ? entries[0] // position 0 was excluded → the next eligible member leads
          : atZero;
  // A tier whose every member is non-routable is unusable — surfaced as the
  // existing empty-tier error before any attempt, never a walk that cannot win.
  if (!primary) return { error: 'empty_tier', detail: tier.key };
  const chain: RouteTarget[] = [];
  if (mode === 'batch') {
    // A batch submits exactly once and never falls back across the completion
    // window, so its "chain" is the single candidate — a longer one would imply a
    // promotion this rule forbids.
    const m = modelById(primary.modelId);
    if (m) chain.push(target(m));
  } else {
    for (const e of entries) {
      const m = modelById(e.modelId);
      if (m) chain.push(target(m));
    }
  }
  const primaryModel = modelById(primary.modelId);
  // FK guarantees the model exists; guard defensively as an unresolved target.
  if (!primaryModel || chain.length === 0) return { error: 'unresolved_target', detail: tier.key };
  // A batch's single candidate must still be routable. Refused BY NAME (naming the
  // base id) rather than skipped: `model-variants` forbids dispatching to a twin
  // through ANY path, and skipping would be the promotion D3 rules out. The
  // synchronous branch excludes such members from the chain instead, which is why
  // only this branch needs the check.
  if (mode === 'batch' && !isRoutable(primaryModel)) return batchOnlyError(snap, primaryModel);
  // The exclusion is visible in the recorded reason, on the same terms as #12's
  // capacity-deferral trail — a promoted primary is never silent.
  const parts: string[] = [];
  if (excludedVariant > 0) parts.push(`${String(excludedVariant)} batch-only`);
  if (excludedReserved > 0) parts.push(`${String(excludedReserved)} batch-reserved`);
  const effectiveReason = parts.length > 0 ? `${reason} (excluded ${parts.join(', ')})` : reason;
  return {
    providerId: primaryModel.providerId,
    modelId: primaryModel.id,
    externalModelId: primaryModel.externalModelId,
    tierKey: tier.key,
    decisionLayer: layer,
    routingReason: effectiveReason,
    matchedHeader: null, // only resolveRoute's header phases override
    chain,
  };
}

/** Resolve a structured `tier:<key>` / `model:<id>` target into a decision.
 * Exported so Layer 1 (#13) reuses tier chain-building (§7.4) under the
 * `'structural'` layer; a `tier:` target carries the tier's fallback chain, a
 * `model:` target a single-element chain. */
export function resolveTarget(
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
  // A stored target that has since become non-routable is a THIRD state, distinct
  // from unresolved: the row exists and the dashboard shows it. Layer-0 callers
  // surface this by name; the smart layers treat any error as degrade-safe.
  if (!isRoutable(model)) return batchOnlyError(snap, model);
  return modelDecision(model, layer, reason);
}

/** The single deterministic RoutingRule ordering (priority desc, then oldest,
 * then id). Exported and generic over the ordering fields (A-45), so Layer 1
 * (#13) band-rule selection AND the config layer's rule listing share ONE
 * comparator — no drift between how rules are evaluated and how they're shown. */
export const ruleOrder = <T extends { priority: number; createdAt: Date; id: string }>(
  a: T,
  b: T,
): number =>
  b.priority - a.priority ||
  a.createdAt.getTime() - b.createdAt.getTime() ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Resolve a structural/cascade band target: the highest-priority rule of
 * `matchType` (auto_high / auto_low), resolved to a decision — or `null` when no
 * such rule exists or its target is unresolvable. Shared by #13 (structural),
 * #14 (cascade), and Layer 2 so all select band rules with the one
 * deterministic ordering.
 *
 * `scope` (add-workload-scoped-bands): the request's deciding workload class.
 * With a scope, the CLASS-SCOPED rules of the band (`workloadClass === scope`)
 * are consulted first — if any exists, the highest-priority one DECIDES for
 * this request (resolved → its target carrying `scope` — the proxy appends the
 * terminal ` scope=<class>` reason fragment;
 * unresolvable → `null`, i.e. the band is unroutable for the class — never a
 * silent fall-back to the generic rule); only when NO scoped rule of the band
 * exists do the GENERIC (unscoped) rules apply exactly as without a scope.
 * A null/undefined scope is byte-identical to the pre-scope behaviour. */
export function resolveBandTarget(
  snap: RoutingSnapshot,
  matchType: string,
  layer: DecisionLayer,
  reason: string,
  scope?: string | null,
): RouteDecision | null {
  const ofBand = snap.rules.filter((r) => r.matchType === matchType);
  const isGeneric = (r: RouteRule): boolean =>
    r.workloadClass === null || r.workloadClass === undefined;
  let rule: RouteRule | undefined;
  let scoped = false;
  if (scope !== undefined && scope !== null) {
    rule = ofBand.filter((r) => r.workloadClass === scope).sort(ruleOrder)[0];
    scoped = rule !== undefined;
  }
  if (rule === undefined) rule = ofBand.filter(isGeneric).sort(ruleOrder)[0];
  if (rule === undefined) return null;
  const decision = resolveTarget(snap, rule.target, layer, reason);
  if (isRouteError(decision)) return null;
  return scoped ? { ...decision, scope: String(scope) } : decision;
}

/** Whether the band's SELECTED rule for `scope` is class-scoped (add-workload-
 * scoped-bands): the cascade plan records per-leg provenance with this so the
 * learning contributor can tell a scoped cheap leg from the generic one. */
export function bandRuleIsScoped(
  snap: RoutingSnapshot,
  matchType: string,
  scope: string | null | undefined,
): boolean {
  if (scope === undefined || scope === null) return false;
  return snap.rules.some((r) => r.matchType === matchType && r.workloadClass === scope);
}

/** Resolve a WORKLOAD target (add-workload-routing): the highest-priority
 * `auto_workload` rule bound to `cls` — the SAME comparator band rules use, so
 * `priority` orders duplicates within a class — rendered with layer
 * `workload` and the verdict's numbers-only reason (a `tier:` target carries
 * its chain, a `model:` target is that single model). `null` when no rule
 * binds the class or its target is unresolved/empty: the caller treats null
 * as "unclaimed" — degrade-safe, never a client-facing error (invariant 1). */
export function resolveWorkloadTarget(
  snap: RoutingSnapshot,
  cls: string,
  reason: string,
): RouteDecision | null {
  const rule = [...snap.rules]
    .filter((r) => r.matchType === 'auto_workload' && r.workloadClass === cls)
    .sort(ruleOrder)[0];
  if (rule === undefined) return null;
  const decision = resolveTarget(snap, rule.target, 'workload', reason);
  return isRouteError(decision) ? null : decision;
}

export function resolveRoute(
  snap: RoutingSnapshot,
  parsed: ParsedRoute,
): RouteDecision | RouteError {
  const mf = parsed.modelField;
  // Which mode this resolution is FOR. Rules are unreachable on the batch path (a
  // batch always names a non-empty explicit model or tier, so phase 1 terminates
  // first), so only the tier phases need it.
  const resolutionMode: ResolutionMode = parsed.mode ?? 'sync';

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
      if (qualified) {
        // The exact row decides — even if a routable model elsewhere shares the
        // bare id, a qualified ask names THIS one (add-model-variant-detection).
        if (!isRoutable(qualified)) return batchOnlyError(snap, qualified);
        return modelDecision(qualified, 'explicit', `explicit model ${externalModelId}`);
      }
      // else: the colon was part of a bare model id — fall through.
    }
    // Bare external id. Ambiguity is counted over ROUTABLE matches only, so this
    // phase and `GET /v1/models` (which advertises only routable ids) can never
    // disagree about whether an advertised id resolves.
    const matches = snap.models.filter((m) => m.externalModelId === mf);
    const routable = matches.filter(isRoutable);
    if (routable.length === 1)
      return modelDecision(routable[0]!, 'explicit', `explicit model ${mf}`);
    if (routable.length > 1) return { error: 'ambiguous_model', detail: mf };
    // No routable match, but the id IS a model the tenant owns: refuse by name
    // rather than send them to qualify an id that cannot serve under any provider.
    if (matches.length > 0) return batchOnlyError(snap, matches[0]!);
    // tier key (a name that is both a model and a tier resolved to the model above)
    const tier = snap.tiers.find((t) => t.key === mf);
    if (tier) return resolveTier(snap, tier, 'explicit', `explicit tier ${mf}`, resolutionMode);
    // non-empty, unrecognized → a clear error, never a silent default
    return { error: 'unknown_model', detail: mf };
  }

  // Phase 1 made no selection (empty or `auto`): fall through to header/default.
  const rules = [...snap.rules].sort(ruleOrder);

  // Phase 2 — the tier-header phase (add-tier-header-precedence): a request
  // carrying a non-empty `x-polyrouter-tier` that RESOLVES here wins
  // structurally — no rule on another header, of any priority, can shadow the
  // per-request tier ask. The decision carries the matched OWNED config value
  // (never raw client bytes): `x-polyrouter-tier` is a routing-CATEGORY header,
  // so its tier-ask value is recorded (record-tier-header-value). Rules on any
  // OTHER header still emit the name only — a value there can be a credential.
  const builtin = parsed.headers[TIER_HEADER_NAME];
  if (builtin !== undefined && builtin.length > 0) {
    // 2a — value remaps: tier-header rules matching the sent value (the
    // dashboard's Header rules). A remap beats the direct lookup so it stays
    // effective even when its value collides with a literal tier key.
    for (const r of rules) {
      if (r.matchType !== 'header' || r.headerValue === null) continue;
      if (r.headerName.toLowerCase() !== TIER_HEADER_NAME) continue;
      if (builtin === r.headerValue) {
        const d = resolveTarget(snap, r.target, 'header', `header rule ${r.headerName}`);
        if (isRouteError(d)) return d;
        // Record the matched OWNED rule value (the tier-ask category, e.g.
        // `shopping`) — the same config-side provenance the direct lookup uses for
        // its tier.key, though the string differs (a remap's value ≠ its target
        // tier). Never the raw client string.
        return { ...d, matchedHeader: { name: r.headerName, value: r.headerValue } };
      }
    }
    // 2b — the sent value naming an owned tier directly.
    const tier = snap.tiers.find((t) => t.key === builtin);
    if (tier) {
      const d = resolveTier(
        snap,
        tier,
        'header',
        `${TIER_HEADER_NAME}: ${builtin}`,
        resolutionMode,
      );
      if (isRouteError(d)) return d;
      // tier.key, not the client string — the value is the OWNED tier key that
      // matched (identical bytes, config-side provenance).
      return { ...d, matchedHeader: { name: TIER_HEADER_NAME, value: tier.key } };
    }
    // a value matching no remap and no tier is advisory — fall through.
  }

  // Phase 3 — rules on OTHER headers (tier-header rules are exclusively
  // phase-2 remaps; without the tier header they could never match anyway).
  for (const r of rules) {
    if (r.matchType !== 'header' || r.headerValue === null) continue;
    if (r.headerName.toLowerCase() === TIER_HEADER_NAME) continue;
    if (parsed.headers[r.headerName.toLowerCase()] === r.headerValue) {
      const d = resolveTarget(snap, r.target, 'header', `header rule ${r.headerName}`);
      if (isRouteError(d)) return d;
      return { ...d, matchedHeader: { name: r.headerName, value: null } };
    }
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
    resolutionMode,
  );
}
