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
  }),
);

type SemanticEnv = {
  SEMANTIC_MODEL_PATH?: string;
  SEMANTIC_TIMEOUT_MS: number;
  SEMANTIC_MAX_INPUT_CHARS: number;
  SEMANTIC_CONCURRENCY: number;
  SEMANTIC_HIGH_THRESHOLD: number;
  SEMANTIC_LOW_THRESHOLD: number;
};

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
}

export function buildSemanticConfig(env: SemanticEnv): SemanticConfig {
  const raw = env.SEMANTIC_MODEL_PATH?.trim();
  const is4dp = (n: number): boolean => Math.round(n * 10_000) / 10_000 === n;
  if (!is4dp(env.SEMANTIC_HIGH_THRESHOLD) || !is4dp(env.SEMANTIC_LOW_THRESHOLD)) {
    throw new Error('SEMANTIC_*_THRESHOLD must have at most 4 decimal places');
  }
  return {
    modelPath: raw === undefined || raw === '' ? undefined : raw,
    timeoutMs: env.SEMANTIC_TIMEOUT_MS,
    maxInputChars: env.SEMANTIC_MAX_INPUT_CHARS,
    concurrency: env.SEMANTIC_CONCURRENCY,
    highThreshold: env.SEMANTIC_HIGH_THRESHOLD,
    lowThreshold: env.SEMANTIC_LOW_THRESHOLD,
  };
}

export function loadSemanticConfig(): SemanticConfig {
  return buildSemanticConfig(loadConfig<SemanticEnv>());
}
