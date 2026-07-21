import { ConfigValidationError, configRegistry } from '@polyrouter/shared';
import { buildSemanticConfig } from './semantic.config';

describe('buildSemanticConfig (add-semantic-embedder)', () => {
  const BASE = {
    SEMANTIC_TIMEOUT_MS: 50,
    SEMANTIC_MAX_INPUT_CHARS: 2000,
    SEMANTIC_CONCURRENCY: 2,
    SEMANTIC_HIGH_THRESHOLD: 0.15,
    SEMANTIC_LOW_THRESHOLD: 0.15,
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
    });
  });

  it('rejects thresholds finer than 4 decimals', () => {
    expect(() => buildSemanticConfig({ ...BASE, SEMANTIC_HIGH_THRESHOLD: 0.12345 })).toThrow(
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
