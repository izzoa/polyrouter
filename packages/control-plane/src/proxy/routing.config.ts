import { loadConfig, registerConfig, z } from '@polyrouter/shared';
import {
  DEFAULT_REASONING_ADJUST,
  DEFAULT_STRUCTURAL_WEIGHTS,
  STRUCTURAL_WEIGHT_KEYS,
  type StructuralWeights,
} from '@polyrouter/data-plane';

/** Automatic-routing config (#13, spec §7.2/§7.6). `ROUTING_AUTO_LAYERS` gates
 * the opt-in smart layers (default `structural`; empty → pure Layer 0); the
 * structural thresholds/alpha/weights are the "expose thresholds/weights for
 * power users" knobs. Semantic cross-field validation (LOW < HIGH, weight
 * shape) runs in the loader and fails boot fast (§12). */

export const ROUTING_CONFIG = 'polyrouter:routing-config';

registerConfig(
  'routing',
  z.object({
    ROUTING_AUTO_LAYERS: z.string().default('structural'),
    ROUTING_STRUCTURAL_HIGH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
    ROUTING_STRUCTURAL_LOW_THRESHOLD: z.coerce.number().min(0).max(1).default(0.25),
    ROUTING_STRUCTURAL_BASELINE_ALPHA: z.coerce.number().gt(0).max(1).default(0.2),
    ROUTING_STRUCTURAL_WEIGHTS: z.string().optional(),
    ROUTING_CASCADE_QUALITY_THRESHOLD: z.coerce.number().gt(0).max(1).default(0.5),
    ROUTING_CASCADE_CHEAP_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  }),
);

export type RoutingEnv = {
  ROUTING_AUTO_LAYERS: string;
  ROUTING_STRUCTURAL_HIGH_THRESHOLD: number;
  ROUTING_STRUCTURAL_LOW_THRESHOLD: number;
  ROUTING_STRUCTURAL_BASELINE_ALPHA: number;
  ROUTING_STRUCTURAL_WEIGHTS?: string;
  ROUTING_CASCADE_QUALITY_THRESHOLD: number;
  ROUTING_CASCADE_CHEAP_TIMEOUT_MS: number;
};

export interface StructuralConfig {
  readonly high: number;
  readonly low: number;
  readonly baselineAlpha: number;
  readonly weights: StructuralWeights;
  /** Declared-reasoning adjustment magnitude R (add-auto-hint-features);
   * bounded [0, 0.5]. Configured as the `reasoning` key of
   * ROUTING_STRUCTURAL_WEIGHTS — EXCLUDED from ambient normalization. */
  readonly reasoningAdjust: number;
}

export interface CascadeConfig {
  /** Layer 3 (cascade) enabled — implies structural (the ambiguity signal). */
  readonly enabled: boolean;
  /** Escalate when the cheap answer's quality score is below this (0,1]. */
  readonly qualityThreshold: number;
  /** Bound on the buffered cheap-response drain so a hung upstream still escalates. */
  readonly cheapTimeoutMs: number;
}

export interface RoutingConfig {
  /** Enabled smart layers (e.g. `structural`); empty = pure Layer 0. */
  readonly autoLayers: ReadonlySet<string>;
  readonly structural: StructuralConfig;
  readonly cascade: CascadeConfig;
}

/** Parse + validate the optional weight override: the 7 AMBIENT keys are merged
 * over the built-ins and normalized to sum 1 (byte-identical legacy semantics);
 * the `reasoning` key is the declared-adjustment MAGNITUDE R — excluded from
 * normalization, bounded [0, 0.5] (add-auto-hint-features). Rejects unknown
 * keys and any non-finite/negative value. */
export function parseStructuralWeights(json: string | undefined): {
  weights: StructuralWeights;
  reasoningAdjust: number;
} {
  if (json === undefined || json.trim() === '') {
    return { weights: DEFAULT_STRUCTURAL_WEIGHTS, reasoningAdjust: DEFAULT_REASONING_ADJUST };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('ROUTING_STRUCTURAL_WEIGHTS must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('ROUTING_STRUCTURAL_WEIGHTS must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const known = new Set<string>([...STRUCTURAL_WEIGHT_KEYS, 'reasoning']);
  for (const k of Object.keys(obj)) {
    if (!known.has(k)) throw new Error(`ROUTING_STRUCTURAL_WEIGHTS has unknown key "${k}"`);
  }
  let reasoningAdjust = DEFAULT_REASONING_ADJUST;
  if ('reasoning' in obj) {
    const r = obj['reasoning'];
    if (typeof r !== 'number' || !Number.isFinite(r) || r < 0 || r > 0.5) {
      throw new Error('ROUTING_STRUCTURAL_WEIGHTS.reasoning must be a finite number in [0, 0.5]');
    }
    reasoningAdjust = r;
  }
  const merged: Record<keyof StructuralWeights, number> = { ...DEFAULT_STRUCTURAL_WEIGHTS };
  for (const k of STRUCTURAL_WEIGHT_KEYS) {
    if (k in obj) {
      const v = obj[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new Error(`ROUTING_STRUCTURAL_WEIGHTS.${k} must be a finite number ≥ 0`);
      }
      merged[k] = v;
    }
  }
  const sum = STRUCTURAL_WEIGHT_KEYS.reduce((a, k) => a + merged[k], 0);
  if (!Number.isFinite(sum) || sum <= 0) {
    throw new Error('ROUTING_STRUCTURAL_WEIGHTS must have a positive finite sum');
  }
  const normalized = {} as Record<keyof StructuralWeights, number>;
  for (const k of STRUCTURAL_WEIGHT_KEYS) {
    const n = merged[k] / sum;
    if (!Number.isFinite(n)) {
      throw new Error('ROUTING_STRUCTURAL_WEIGHTS normalization produced a non-finite value');
    }
    normalized[k] = n;
  }
  return { weights: normalized, reasoningAdjust };
}

/** Pure: apply the semantic (cross-field) validation the zod fragment cannot —
 * `LOW < HIGH`, weight shape — over an already-parsed env. Throws on any problem
 * (boot fails fast). Exposed for unit testing without the global registry. */
export function buildRoutingConfig(env: RoutingEnv): RoutingConfig {
  const autoLayers = new Set(
    env.ROUTING_AUTO_LAYERS.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  // Cascade consumes Layer 1's ambiguity signal, so enabling it implies structural.
  if (autoLayers.has('cascade')) autoLayers.add('structural');
  const high = env.ROUTING_STRUCTURAL_HIGH_THRESHOLD;
  const low = env.ROUTING_STRUCTURAL_LOW_THRESHOLD;
  if (!(low < high)) {
    throw new Error(
      'ROUTING_STRUCTURAL_LOW_THRESHOLD must be strictly less than ROUTING_STRUCTURAL_HIGH_THRESHOLD',
    );
  }
  const alpha = env.ROUTING_STRUCTURAL_BASELINE_ALPHA;
  if (!(alpha > 0 && alpha <= 1)) {
    throw new Error('ROUTING_STRUCTURAL_BASELINE_ALPHA must be in (0, 1]');
  }
  const structuralWeights = parseStructuralWeights(env.ROUTING_STRUCTURAL_WEIGHTS);
  return {
    autoLayers,
    structural: {
      high,
      low,
      baselineAlpha: alpha,
      weights: structuralWeights.weights,
      reasoningAdjust: structuralWeights.reasoningAdjust,
    },
    cascade: {
      enabled: autoLayers.has('cascade'),
      qualityThreshold: env.ROUTING_CASCADE_QUALITY_THRESHOLD,
      cheapTimeoutMs: env.ROUTING_CASCADE_CHEAP_TIMEOUT_MS,
    },
  };
}

export function loadRoutingConfig(): RoutingConfig {
  return buildRoutingConfig(loadConfig<RoutingEnv>());
}

/** The instance's auto-layer CAPABILITY, from the boot-resolved config (#20).
 * Pure over the injected `ROUTING_CONFIG` singleton (NOT a fresh env read) so the
 * dashboard's reported capability can't drift from what the routers enforce. */
export function autoLayerCapability(cfg: RoutingConfig): { structural: boolean; cascade: boolean } {
  return { structural: cfg.autoLayers.has('structural'), cascade: cfg.cascade.enabled };
}

/** The single "effective layers" formula (A-45): a layer is on iff the instance
 * CAN do it (`cap`) AND the tenant preference allows it (default-on when unset).
 * Shared by the dashboard's `AutoLayersService` and the proxy's per-request read so
 * the two can never drift. `structuralAvailable`/`cascadeAvailable` come from `cap`. */
export function effectiveAutoLayers(
  cap: { structural: boolean; cascade: boolean },
  pref: { structuralEnabled: boolean; cascadeEnabled: boolean } | null,
): { structural: boolean; cascade: boolean } {
  return {
    structural: cap.structural && (pref?.structuralEnabled ?? true),
    cascade: cap.cascade && (pref?.cascadeEnabled ?? true),
  };
}
