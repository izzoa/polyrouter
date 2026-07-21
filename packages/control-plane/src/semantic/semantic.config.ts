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
  }),
);

type SemanticEnv = {
  SEMANTIC_MODEL_PATH?: string;
  SEMANTIC_TIMEOUT_MS: number;
  SEMANTIC_MAX_INPUT_CHARS: number;
  SEMANTIC_CONCURRENCY: number;
};

export interface SemanticConfig {
  /** Absent (undefined/blank) = the optional module never activates. */
  readonly modelPath: string | undefined;
  readonly timeoutMs: number;
  readonly maxInputChars: number;
  readonly concurrency: number;
}

export function buildSemanticConfig(env: SemanticEnv): SemanticConfig {
  const raw = env.SEMANTIC_MODEL_PATH?.trim();
  return {
    modelPath: raw === undefined || raw === '' ? undefined : raw,
    timeoutMs: env.SEMANTIC_TIMEOUT_MS,
    maxInputChars: env.SEMANTIC_MAX_INPUT_CHARS,
    concurrency: env.SEMANTIC_CONCURRENCY,
  };
}

export function loadSemanticConfig(): SemanticConfig {
  return buildSemanticConfig(loadConfig<SemanticEnv>());
}
