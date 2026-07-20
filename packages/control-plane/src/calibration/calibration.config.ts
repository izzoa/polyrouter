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
