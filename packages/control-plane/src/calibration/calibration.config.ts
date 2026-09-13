import { loadConfig, registerConfig, z } from '@polyrouter/shared';

/** Threshold-calibration config (add-auto-threshold-calibration). The
 * scheduler knobs gate the background job; the rails bound every move. All
 * validation fails boot fast (§12). `CALIBRATION_MIN_EDGE_SAMPLES` has a HARD
 * FLOOR of 50 — the knob only turns up: below ~50 the Wilson bounds at the
 * decision rates stop being informative and one observation per cooldown
 * could ratchet a sparse tenant. */

export const CALIBRATION_RAILS = 'polyrouter:calibration-rails';
export const CALIBRATION_CONFIG = 'polyrouter:calibration-config';

/** The floor is a rail, not a default — enforced in the schema itself. */
export const MIN_EDGE_SAMPLES_FLOOR = 50;

/** Internal constants (design §3) — deliberately not env. */
export const EDGE_WIDTH = 0.05;
export const RATE_HIGH = 0.65;
export const RATE_LOW = 0.15;
export const COOLDOWN_DAYS = 3;
export const MIN_GAP = 0.1;

registerConfig(
  'calibration',
  z.object({
    CALIBRATION_SCHED_ENABLED: z.string().default('true'),
    CALIBRATION_SCHED_CRON: z.string().default('0 4 * * *'),
    CALIBRATION_WINDOW_DAYS: z.coerce.number().int().min(1).default(14),
    CALIBRATION_MIN_EDGE_SAMPLES: z.coerce.number().int().min(MIN_EDGE_SAMPLES_FLOOR).default(50),
    CALIBRATION_STEP: z.coerce.number().gt(0).max(0.2).default(0.02),
    CALIBRATION_MAX_DRIFT: z.coerce.number().max(0.3).default(0.1),
  }),
);

type CalibrationEnv = {
  CALIBRATION_SCHED_ENABLED: string;
  CALIBRATION_SCHED_CRON: string;
  CALIBRATION_WINDOW_DAYS: number;
  CALIBRATION_MIN_EDGE_SAMPLES: number;
  CALIBRATION_STEP: number;
  CALIBRATION_MAX_DRIFT: number;
};

export interface CalibrationConfig {
  readonly schedEnabled: boolean;
  readonly cron: string;
  readonly windowDays: number;
  readonly minEdgeSamples: number;
  readonly step: number;
  readonly maxDrift: number;
}

/** The rails the HOT PATH re-validates a stored pair against on every read
 * (a rail-config change is never grandfathered). */
export interface CalibrationRails {
  readonly maxDrift: number;
  readonly minGap: number;
}

/** Pure cross-field validation over an already-parsed env (unit-testable
 * without the global registry); throws on any problem — boot fails fast. */
export function buildCalibrationConfig(env: CalibrationEnv): CalibrationConfig {
  const step = env.CALIBRATION_STEP;
  const maxDrift = env.CALIBRATION_MAX_DRIFT;
  if (!(step <= maxDrift)) {
    throw new Error('CALIBRATION_STEP must be <= CALIBRATION_MAX_DRIFT');
  }
  // ONE canonical precision (r3-Med-3): thresholds and rails are 4-decimal
  // everywhere (the calibrator persists 4-decimal values and both the writer
  // and the hot path compare 4-decimal-rounded differences). A finer-grained
  // rail would let the writer permit a pair the hot path instantly inerts —
  // an audited move followed by a rebase. Reject at boot instead.
  const is4dp = (n: number): boolean => Math.round(n * 10_000) / 10_000 === n;
  if (!is4dp(step)) {
    throw new Error('CALIBRATION_STEP must have at most 4 decimal places');
  }
  if (!is4dp(maxDrift)) {
    throw new Error('CALIBRATION_MAX_DRIFT must have at most 4 decimal places');
  }
  return {
    schedEnabled: env.CALIBRATION_SCHED_ENABLED !== 'false',
    cron: env.CALIBRATION_SCHED_CRON,
    windowDays: env.CALIBRATION_WINDOW_DAYS,
    minEdgeSamples: env.CALIBRATION_MIN_EDGE_SAMPLES,
    step,
    maxDrift,
  };
}

export function loadCalibrationConfig(): CalibrationConfig {
  return buildCalibrationConfig(loadConfig<CalibrationEnv>());
}

export function railsOf(cfg: CalibrationConfig): CalibrationRails {
  return { maxDrift: cfg.maxDrift, minGap: MIN_GAP };
}

/** Is a `high − low` gap wide enough to be BOTH admissible and non-halting
 * (fix-tangent-gap-rail)?
 *
 * TWO bounds, and neither implies the other:
 *   1. `>= minGap` — the configured minimum gap.
 *   2. `> 2 * EDGE_WIDTH` — strictly wider than the two edge zones, which are
 *      `[high−w, high)` and `(low, low+w]`. At exactly `2w` they meet at one
 *      shared score, which `calibrationHalted` treats (correctly) as degenerate.
 *
 * The shipped constants make them EQUAL — `MIN_GAP` is 0.1 and `2 * EDGE_WIDTH`
 * is 0.1 — so before this predicate existed the two rails were tangent and tied
 * in OPPOSITE directions: a candidate at exactly 0.1 passed admission (`< minGap`
 * is false) and was then inerted by the halt rail (`<=` is true), permanently
 * freezing the tenant it had just calibrated. Bound 2 is what refuses that move.
 *
 * NOT `> max(minGap, 2 * EDGE_WIDTH)`: that is right for today's constants but
 * silently relaxes a LARGER configured `minGap` from `>=` to `>`, changing the
 * admissible region for a knob nobody asked to change. Keep the bounds separate.
 *
 * Rounded to the same 4 decimals as every other rail comparison — a finer
 * precision here would let the writer admit a pair the hot path instantly inerts. */
export function gapAdmissible(gap: number, rails: CalibrationRails): boolean {
  const g = Math.round(gap * 10_000) / 10_000;
  return g >= rails.minGap && g > 2 * EDGE_WIDTH;
}

/** Is the calibrator HALTED for this tenant — would `calibrateTenant` decline to
 * evaluate it at all (fix-calibration-evidence-honesty)?
 *
 * Two conditions, both pre-existing in the sweep: a degenerate INSTANCE pair
 * narrower than the minimum gap, and effective edge zones that touch or overlap
 * (inclusive, because the zones are [high−w, high) and (low, low+w], so equality
 * means one shared score). Extracted so the calibrator and the read-time
 * evidence report share ONE definition — a restatement in the analytics layer
 * would be a second copy of a rule that has already moved once.
 *
 * Both conditions are now `gapAdmissible` (fix-tangent-gap-rail), which is where
 * the zone-touch comparison went: `high − w <= low + w` is exactly
 * `gap <= 2 * EDGE_WIDTH`, i.e. the negation of that predicate's second bound.
 * Applying the WHOLE predicate to the effective pair is equivalent-or-stricter —
 * `effectiveThresholds` already refuses to return a pair below `minGap`, so the
 * added first bound can only fire on an instance pair, which condition one
 * covers anyway. Three call sites, one rule; that is the point of this helper.
 */
export function calibrationHalted(
  instance: { high: number; low: number },
  effective: { high: number; low: number },
  rails: CalibrationRails,
): boolean {
  return (
    !gapAdmissible(instance.high - instance.low, rails) ||
    !gapAdmissible(effective.high - effective.low, rails)
  );
}
