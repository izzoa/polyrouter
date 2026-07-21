import { ConfigValidationError, configRegistry } from '@polyrouter/shared';
import { buildSemanticConfig } from './semantic.config';

describe('buildSemanticConfig (add-semantic-embedder)', () => {
  const BASE = {
    SEMANTIC_TIMEOUT_MS: 50,
    SEMANTIC_MAX_INPUT_CHARS: 2000,
    SEMANTIC_CONCURRENCY: 2,
    SEMANTIC_HIGH_THRESHOLD: 0.15,
    SEMANTIC_LOW_THRESHOLD: 0.15,
    SEMANTIC_LEARNING_MIN_COHORT: 8,
    SEMANTIC_LEARNING_MIN_SAMPLES: 50,
    SEMANTIC_LEARNING_ALPHA: 0.2,
    SEMANTIC_LEARNING_MAX_DRIFT: 0.35,
    SEMANTIC_LEARNING_COOLDOWN_H: 24,
    SEMANTIC_LEARNING_STATE_TTL_D: 30,
    SEMANTIC_LEARNING_MAX_COHORTS: 4096,
    SEMANTIC_LEARNING_SCHED_ENABLED: 'true',
    SEMANTIC_LEARNING_SCHED_CRON: '0 3 * * *',
  };

  it('unset/blank path means the module is absent', () => {
    expect(buildSemanticConfig({ ...BASE }).modelPath).toBeUndefined();
    expect(buildSemanticConfig({ ...BASE, SEMANTIC_MODEL_PATH: '' }).modelPath).toBeUndefined();
    expect(buildSemanticConfig({ ...BASE, SEMANTIC_MODEL_PATH: '   ' }).modelPath).toBeUndefined();
  });

  it('passes bounds through and trims the path', () => {
    const cfg = buildSemanticConfig({ ...BASE, SEMANTIC_MODEL_PATH: ' /models/minilm ' });
    expect(cfg).toEqual({
      modelPath: '/models/minilm',
      timeoutMs: 50,
      maxInputChars: 2000,
      concurrency: 2,
      highThreshold: 0.15,
      lowThreshold: 0.15,
      learning: {
        minCohort: 8,
        minSamples: 50,
        alpha: 0.2,
        maxDrift: 0.35,
        cooldownH: 24,
        stateTtlD: 30,
        maxCohorts: 4096,
        schedEnabled: true,
        schedCron: '0 3 * * *',
      },
    });
  });

  it('rejects thresholds finer than 4 decimals', () => {
    expect(() => buildSemanticConfig({ ...BASE, SEMANTIC_HIGH_THRESHOLD: 0.12345 })).toThrow(
      /4 decimal/,
    );
  });

  it('rejects learning cross-field rail violations (add-semantic-learning)', () => {
    // MIN_SAMPLES must be >= MIN_COHORT
    expect(() =>
      buildSemanticConfig({
        ...BASE,
        SEMANTIC_LEARNING_MIN_COHORT: 60,
        SEMANTIC_LEARNING_MIN_SAMPLES: 50,
      }),
    ).toThrow(/MIN_SAMPLES/);
    // COOLDOWN_H must be < STATE_TTL_D (in hours: 30d = 720h)
    expect(() =>
      buildSemanticConfig({
        ...BASE,
        SEMANTIC_LEARNING_COOLDOWN_H: 800,
        SEMANTIC_LEARNING_STATE_TTL_D: 30,
      }),
    ).toThrow(/COOLDOWN_H/);
    // ALPHA finer than 4 decimals
    expect(() => buildSemanticConfig({ ...BASE, SEMANTIC_LEARNING_ALPHA: 0.12345 })).toThrow(
      /4 decimal/,
    );
  });
});

describe('semantic env schema (registered fragment)', () => {
  it('rejects out-of-bounds values at boot, naming the variable (never clamping)', () => {
    // The spec importing semantic.config registered exactly this fragment.
    expect(() => configRegistry.load({ SEMANTIC_TIMEOUT_MS: '2000' })).toThrow(
      ConfigValidationError,
    );
    expect(() => configRegistry.load({ SEMANTIC_TIMEOUT_MS: '5' })).toThrow(/SEMANTIC_TIMEOUT_MS/);
    expect(() => configRegistry.load({ SEMANTIC_MAX_INPUT_CHARS: '100' })).toThrow(
      /SEMANTIC_MAX_INPUT_CHARS/,
    );
    expect(() => configRegistry.load({ SEMANTIC_CONCURRENCY: '0' })).toThrow(
      /SEMANTIC_CONCURRENCY/,
    );
    expect(() => configRegistry.load({ SEMANTIC_CONCURRENCY: '9' })).toThrow(
      /SEMANTIC_CONCURRENCY/,
    );
  });

  it('applies defaults when unset', () => {
    const merged = configRegistry.load({});
    expect(merged).toMatchObject({
      SEMANTIC_TIMEOUT_MS: 50,
      SEMANTIC_MAX_INPUT_CHARS: 2000,
      SEMANTIC_CONCURRENCY: 2,
    });
  });
});
