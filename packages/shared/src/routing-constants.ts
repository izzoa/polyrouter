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

/** Valid rule match types (spec §5, §7.2). `header`/`default` drive Layer-0
 * resolution; `auto_high`/`auto_low` are Layer-1 structural band targets —
 * consumed only by the structural router (#13) and inert in Layer 0;
 * `auto_workload` binds ONE workload class to a target (add-workload-routing)
 * — consumed only by the workload stage, inert in Layer 0, degrade-safe. */
export const RULE_MATCH_TYPES = [
  'header',
  'default',
  'auto_high',
  'auto_low',
  'auto_workload',
] as const;
export type RuleMatchType = (typeof RULE_MATCH_TYPES)[number];

/* ── Workload taxonomy (add-workload-telemetry, Epic W) ─────────────────────────
 *
 * The categorical "what KIND of work is this?" axis beside the complexity axis.
 * ONE shared contract for the proxy, the management API, analytics, and the
 * dashboard: adding/removing/renaming a class is a taxonomy REVISION delivered
 * by a change — never a silent edit. Class keys are lowercase slugs under
 * `TIER_KEY_PATTERN` so they stay header-safe and stable as ids.
 */

/** Bumps when the CLASS LIST changes (add/remove/rename). */
export const WORKLOAD_TAXONOMY_VERSION = 'v1';

/** Bumps for ANY change that affects how the STRUCTURAL source assigns a class —
 * a signal's interpretation, the precedence order, the share rule, or the
 * contributing extractor's semantics (including its scan boundary) — so
 * behaviorally different classifiers never share a `workload_revision` even
 * when thresholds and the class list are unchanged. */
export const STRUCTURAL_WORKLOAD_CLASSIFIER_VERSION = 'c1';

/** The routable workload classes. `research`/`writing` are reserved for the
 * semantic source (a later change) and are never produced structurally. */
export const WORKLOAD_CLASSES = ['code', 'research', 'vision', 'structured', 'writing'] as const;
export type WorkloadClass = (typeof WORKLOAD_CLASSES)[number];

/** Telemetry-only: "evaluated, no specialist workload detected". NEVER a
 * routable class (a rule may not target it). */
export const WORKLOAD_NONE = 'none' as const;
export type WorkloadVerdictClass = WorkloadClass | typeof WORKLOAD_NONE;

/** What the structural source can emit (besides `none`). */
export const STRUCTURAL_WORKLOAD_CLASSES = ['code', 'vision', 'structured'] as const;
export type StructuralWorkloadClass = (typeof STRUCTURAL_WORKLOAD_CLASSES)[number];

/** What the SEMANTIC source can emit besides `none` (add-semantic-workloads):
 * the reserved classes only — the structural classes stay the structural
 * source's by construction (the five-way argmax is internal to the classifier). */
export const SEMANTIC_WORKLOAD_CLASSES = ['research', 'writing'] as const;
export type SemanticWorkloadClass = (typeof SEMANTIC_WORKLOAD_CLASSES)[number];

/** Bumps for ANY change to how the SEMANTIC source assigns a class (the
 * emission rule, the rails' meaning, the argmax/margin semantics) — thresholds,
 * anchors, embedder, and extractor are digested separately into the revision. */
export const SEMANTIC_WORKLOAD_CLASSIFIER_VERSION = 's1';

/** Which classifier produced a verdict. */
export const WORKLOAD_SOURCES = ['structural', 'semantic'] as const;
export type WorkloadSource = (typeof WORKLOAD_SOURCES)[number];
