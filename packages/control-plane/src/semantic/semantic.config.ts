import { loadConfig, registerConfig, z } from '@polyrouter/shared';

/** Semantic-embedder config (add-semantic-embedder). Unset `SEMANTIC_MODEL_PATH`
 * = the module is absent (no import, no capability). Out-of-bounds numeric
 * values REJECT boot (schema min/max — the fail-fast convention; never
 * silently clamped). */

export const SEMANTIC_CONFIG = 'polyrouter:semantic-config';

registerConfig(
  'semantic',
  z.object({
    SEMANTIC_MODEL_PATH: z.string().optional(),
    SEMANTIC_TIMEOUT_MS: z.coerce.number().int().min(10).max(1000).default(50),
    SEMANTIC_MAX_INPUT_CHARS: z.coerce.number().int().min(200).max(8000).default(2000),
    SEMANTIC_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
    SEMANTIC_HIGH_THRESHOLD: z.coerce.number().min(0.01).max(1).default(0.15),
    SEMANTIC_LOW_THRESHOLD: z.coerce.number().min(0.01).max(1).default(0.15),
    // Learning rails (add-semantic-learning D10): FAIL BOOT outside range —
    // never silently clamp. Cross-field checks (MIN_SAMPLES ≥ MIN_COHORT,
    // COOLDOWN < STATE_TTL) run in the builder.
    SEMANTIC_LEARNING_MIN_COHORT: z.coerce.number().int().min(2).max(1000).default(8),
    SEMANTIC_LEARNING_MIN_SAMPLES: z.coerce.number().int().min(2).max(100_000).default(50),
    SEMANTIC_LEARNING_ALPHA: z.coerce.number().gt(0).max(0.5).default(0.2),
    SEMANTIC_LEARNING_MAX_DRIFT: z.coerce.number().gt(0).max(1).default(0.35),
    SEMANTIC_LEARNING_COOLDOWN_H: z.coerce.number().int().min(1).max(8760).default(24),
    SEMANTIC_LEARNING_STATE_TTL_D: z.coerce.number().int().min(1).max(365).default(30),
    SEMANTIC_LEARNING_MAX_COHORTS: z.coerce.number().int().min(16).max(1_000_000).default(4096),
    // Sweep scheduler (add-semantic-learning task 4.2), mirroring the calibration
    // scheduler knobs: producer always runs, the worker only when enabled.
    SEMANTIC_LEARNING_SCHED_ENABLED: z.string().default('true'),
    SEMANTIC_LEARNING_SCHED_CRON: z.string().default('0 3 * * *'),
  }),
);

type SemanticEnv = {
  SEMANTIC_MODEL_PATH?: string;
  SEMANTIC_TIMEOUT_MS: number;
  SEMANTIC_MAX_INPUT_CHARS: number;
  SEMANTIC_CONCURRENCY: number;
  SEMANTIC_HIGH_THRESHOLD: number;
  SEMANTIC_LOW_THRESHOLD: number;
  SEMANTIC_LEARNING_MIN_COHORT: number;
  SEMANTIC_LEARNING_MIN_SAMPLES: number;
  SEMANTIC_LEARNING_ALPHA: number;
  SEMANTIC_LEARNING_MAX_DRIFT: number;
  SEMANTIC_LEARNING_COOLDOWN_H: number;
  SEMANTIC_LEARNING_STATE_TTL_D: number;
  SEMANTIC_LEARNING_MAX_COHORTS: number;
  SEMANTIC_LEARNING_SCHED_ENABLED: string;
  SEMANTIC_LEARNING_SCHED_CRON: string;
};

/** Learning rails (add-semantic-learning D10) + sweep scheduler knobs (task 4.2). */
export interface SemanticLearningConfig {
  readonly minCohort: number;
  readonly minSamples: number;
  readonly alpha: number;
  readonly maxDrift: number;
  readonly cooldownH: number;
  readonly stateTtlD: number;
  readonly maxCohorts: number;
  readonly schedEnabled: boolean;
  readonly schedCron: string;
}

export interface SemanticConfig {
  /** Absent (undefined/blank) = the optional module never activates. */
  readonly modelPath: string | undefined;
  readonly timeoutMs: number;
  readonly maxInputChars: number;
  readonly concurrency: number;
  /** Classifier band cuts (add-semantic-routing): score ≥ high → high,
   * score ≤ −low → low. Independent positives, ≤4 decimals, rails [0.01, 1];
   * defaults 0.15/0.15 (spike-quantile derived, wide-ambiguous). */
  readonly highThreshold: number;
  readonly lowThreshold: number;
  readonly learning: SemanticLearningConfig;
}

export function buildSemanticConfig(env: SemanticEnv): SemanticConfig {
  const raw = env.SEMANTIC_MODEL_PATH?.trim();
  const is4dp = (n: number): boolean => Math.round(n * 10_000) / 10_000 === n;
  if (!is4dp(env.SEMANTIC_HIGH_THRESHOLD) || !is4dp(env.SEMANTIC_LOW_THRESHOLD)) {
    throw new Error('SEMANTIC_*_THRESHOLD must have at most 4 decimal places');
  }
  if (!is4dp(env.SEMANTIC_LEARNING_ALPHA) || !is4dp(env.SEMANTIC_LEARNING_MAX_DRIFT)) {
    throw new Error('SEMANTIC_LEARNING_{ALPHA,MAX_DRIFT} must have at most 4 decimal places');
  }
  // Cross-field rails (D10): the floor can't be below the cohort size, and a
  // cooldown must fit inside the state TTL or a tenant could never re-apply.
  if (env.SEMANTIC_LEARNING_MIN_SAMPLES < env.SEMANTIC_LEARNING_MIN_COHORT) {
    throw new Error('SEMANTIC_LEARNING_MIN_SAMPLES must be >= SEMANTIC_LEARNING_MIN_COHORT');
  }
  if (env.SEMANTIC_LEARNING_COOLDOWN_H >= env.SEMANTIC_LEARNING_STATE_TTL_D * 24) {
    throw new Error(
      'SEMANTIC_LEARNING_COOLDOWN_H must be < SEMANTIC_LEARNING_STATE_TTL_D (in hours)',
    );
  }
  return {
    modelPath: raw === undefined || raw === '' ? undefined : raw,
    timeoutMs: env.SEMANTIC_TIMEOUT_MS,
    maxInputChars: env.SEMANTIC_MAX_INPUT_CHARS,
    concurrency: env.SEMANTIC_CONCURRENCY,
    highThreshold: env.SEMANTIC_HIGH_THRESHOLD,
    lowThreshold: env.SEMANTIC_LOW_THRESHOLD,
    learning: {
      minCohort: env.SEMANTIC_LEARNING_MIN_COHORT,
      minSamples: env.SEMANTIC_LEARNING_MIN_SAMPLES,
      alpha: env.SEMANTIC_LEARNING_ALPHA,
      maxDrift: env.SEMANTIC_LEARNING_MAX_DRIFT,
      cooldownH: env.SEMANTIC_LEARNING_COOLDOWN_H,
      stateTtlD: env.SEMANTIC_LEARNING_STATE_TTL_D,
      maxCohorts: env.SEMANTIC_LEARNING_MAX_COHORTS,
      schedEnabled: env.SEMANTIC_LEARNING_SCHED_ENABLED !== 'false',
      schedCron: env.SEMANTIC_LEARNING_SCHED_CRON,
    },
  };
}

export function loadSemanticConfig(): SemanticConfig {
  return buildSemanticConfig(loadConfig<SemanticEnv>());
}
