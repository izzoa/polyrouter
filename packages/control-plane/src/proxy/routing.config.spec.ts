import { DEFAULT_STRUCTURAL_WEIGHTS } from '@polyrouter/data-plane';
import {
  buildRoutingConfig,
  effectiveThresholds,
  parseStructuralWeights,
  type RoutingEnv,
} from './routing.config';

const base: RoutingEnv = {
  ROUTING_AUTO_LAYERS: 'structural',
  ROUTING_STRUCTURAL_HIGH_THRESHOLD: 0.6,
  ROUTING_STRUCTURAL_LOW_THRESHOLD: 0.25,
  ROUTING_STRUCTURAL_BASELINE_ALPHA: 0.2,
  ROUTING_CASCADE_QUALITY_THRESHOLD: 0.5,
  ROUTING_CASCADE_CHEAP_TIMEOUT_MS: 30_000,
};

describe('buildRoutingConfig', () => {
  it('parses defaults', () => {
    const c = buildRoutingConfig(base);
    expect(c.autoLayers.has('structural')).toBe(true);
    expect(c.structural.high).toBe(0.6);
    expect(c.structural.low).toBe(0.25);
    expect(c.structural.baselineAlpha).toBe(0.2);
    expect(c.structural.weights).toEqual(DEFAULT_STRUCTURAL_WEIGHTS);
  });

  it('parses / trims / lowercases the layer list; empty → none', () => {
    expect([
      ...buildRoutingConfig({ ...base, ROUTING_AUTO_LAYERS: ' Structural , cascade ,' }).autoLayers,
    ]).toEqual(['structural', 'cascade']);
    expect(buildRoutingConfig({ ...base, ROUTING_AUTO_LAYERS: '' }).autoLayers.size).toBe(0);
  });

  it('rejects LOW ≥ HIGH', () => {
    expect(() => buildRoutingConfig({ ...base, ROUTING_STRUCTURAL_LOW_THRESHOLD: 0.6 })).toThrow();
    expect(() => buildRoutingConfig({ ...base, ROUTING_STRUCTURAL_LOW_THRESHOLD: 0.7 })).toThrow();
  });

  it('rejects alpha outside (0, 1]', () => {
    expect(() => buildRoutingConfig({ ...base, ROUTING_STRUCTURAL_BASELINE_ALPHA: 0 })).toThrow();
    expect(() => buildRoutingConfig({ ...base, ROUTING_STRUCTURAL_BASELINE_ALPHA: 1.5 })).toThrow();
  });

  it('cascade implies structural + surfaces the cascade config', () => {
    const c = buildRoutingConfig({ ...base, ROUTING_AUTO_LAYERS: 'cascade' });
    expect(c.autoLayers.has('cascade')).toBe(true);
    expect(c.autoLayers.has('structural')).toBe(true); // implied
    expect(c.cascade.enabled).toBe(true);
    expect(c.cascade.qualityThreshold).toBe(0.5);
    expect(c.cascade.cheapTimeoutMs).toBe(30_000);
  });

  it('cascade disabled when not in the layer list', () => {
    expect(buildRoutingConfig(base).cascade.enabled).toBe(false);
  });

  it('rejects unknown layer tokens naming the offender (add-semantic-embedder)', () => {
    expect(() => buildRoutingConfig({ ...base, ROUTING_AUTO_LAYERS: 'structural,bogus' })).toThrow(
      /unknown layer "bogus"/,
    );
    // The typo case the validator exists for — previously silently inert:
    expect(() => buildRoutingConfig({ ...base, ROUTING_AUTO_LAYERS: 'semantci' })).toThrow(
      /semantci/,
    );
  });

  it('accepts semantic (inert until add-semantic-routing); existing deploy strings still parse', () => {
    expect(
      buildRoutingConfig({ ...base, ROUTING_AUTO_LAYERS: 'structural,semantic' }).autoLayers.has(
        'semantic',
      ),
    ).toBe(true);
    for (const legacy of ['structural', 'structural,cascade', 'cascade', '']) {
      expect(() => buildRoutingConfig({ ...base, ROUTING_AUTO_LAYERS: legacy })).not.toThrow();
    }
  });
});

describe('parseStructuralWeights', () => {
  it('returns the built-ins when absent/empty', () => {
    expect(parseStructuralWeights(undefined)).toEqual({
      weights: DEFAULT_STRUCTURAL_WEIGHTS,
      reasoningAdjust: 0.1,
    });
    expect(parseStructuralWeights('').weights).toEqual(DEFAULT_STRUCTURAL_WEIGHTS);
  });

  it('merges an override over the built-ins and normalizes to sum 1', () => {
    const { weights: w } = parseStructuralWeights('{"size":0.5}');
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(w.size).toBeGreaterThan(DEFAULT_STRUCTURAL_WEIGHTS.size);
  });

  it('legacy 7-key overrides are byte-identical; `reasoning` is a bounded magnitude, not a weight (add-auto-hint-features)', () => {
    const legacy = '{"size":0.4,"code":0.2,"tools":0.1,"schema":0.1,"depth":0.1,"multimodal":0.05,"maxTokens":0.05}';
    const parsed = parseStructuralWeights(legacy);
    const sum = Object.values(parsed.weights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(parsed.weights.size).toBeCloseTo(0.4, 6); // ambient normalization untouched by the new key
    expect(parsed.reasoningAdjust).toBe(0.1); // default fills in — no dilution of ambient ratios

    expect(parseStructuralWeights('{"reasoning":0.25}').reasoningAdjust).toBe(0.25);
    expect(parseStructuralWeights('{"reasoning":0}').reasoningAdjust).toBe(0);
    expect(() => parseStructuralWeights('{"reasoning":0.6}')).toThrow(); // bound [0, 0.5]
    expect(() => parseStructuralWeights('{"reasoning":-0.1}')).toThrow();
    expect(() => parseStructuralWeights('{"reasoning":"high"}')).toThrow();
  });

  it('rejects unknown keys, negatives, non-finite values, a zero sum, and bad JSON', () => {
    expect(() => parseStructuralWeights('{"nope":1}')).toThrow();
    expect(() => parseStructuralWeights('{"size":-1}')).toThrow();
    expect(() => parseStructuralWeights('{"size":1e309}')).toThrow(); // JSON.parse → Infinity
    expect(() =>
      parseStructuralWeights(
        '{"size":0,"code":0,"tools":0,"schema":0,"depth":0,"multimodal":0,"maxTokens":0}',
      ),
    ).toThrow();
    expect(() => parseStructuralWeights('not json')).toThrow();
    expect(() => parseStructuralWeights('[1,2,3]')).toThrow();
  });
});

describe('effectiveThresholds (add-auto-threshold-calibration)', () => {
  const cfg = { high: 0.6, low: 0.25 };
  const rails = { maxDrift: 0.1, minGap: 0.1 };
  const instance = { high: 0.6, low: 0.25 };
  /** A valid, anchored, rail-clean pair over the default instance config. */
  const pref = (over: Partial<Parameters<typeof effectiveThresholds>[1] & object> = {}) => ({
    calibratedHigh: 0.55,
    calibratedLow: 0.3,
    calibratedAnchorHigh: 0.6,
    calibratedAnchorLow: 0.25,
    ...over,
  });

  it('applies a valid anchored rail-clean pair', () => {
    expect(effectiveThresholds(cfg, pref(), rails)).toEqual({ high: 0.55, low: 0.3 });
  });

  it('null pref (no row / timed-out read) → instance', () => {
    expect(effectiveThresholds(cfg, null, rails)).toEqual(instance);
  });

  it('a partial pair → instance (the quad travels together)', () => {
    expect(effectiveThresholds(cfg, pref({ calibratedLow: null }), rails)).toEqual(instance);
    expect(effectiveThresholds(cfg, pref({ calibratedAnchorHigh: null }), rails)).toEqual(instance);
  });

  it('a poisoned pair (non-finite, out of range, inverted) → instance', () => {
    expect(effectiveThresholds(cfg, pref({ calibratedHigh: Number.NaN }), rails)).toEqual(instance);
    expect(effectiveThresholds(cfg, pref({ calibratedHigh: 1.2 }), rails)).toEqual(instance);
    expect(effectiveThresholds(cfg, pref({ calibratedLow: -0.1 }), rails)).toEqual(instance);
    expect(
      effectiveThresholds(cfg, pref({ calibratedHigh: 0.3, calibratedLow: 0.4 }), rails),
    ).toEqual(instance);
  });

  it('an anchor mismatch (changed instance defaults) inerts the pair immediately', () => {
    expect(effectiveThresholds(cfg, pref({ calibratedAnchorHigh: 0.7 }), rails)).toEqual(instance);
    expect(effectiveThresholds(cfg, pref({ calibratedAnchorLow: 0.2 }), rails)).toEqual(instance);
  });

  it('expansion beyond the anchor (contraction only) → instance', () => {
    expect(effectiveThresholds(cfg, pref({ calibratedHigh: 0.65 }), rails)).toEqual(instance);
    expect(effectiveThresholds(cfg, pref({ calibratedLow: 0.2 }), rails)).toEqual(instance);
  });

  it('over-drift under the CURRENT rails → instance (a rail change is never grandfathered)', () => {
    // 0.6 − 0.45 = 0.15 drift: fine at maxDrift 0.2, inert at 0.1.
    const wide = pref({ calibratedHigh: 0.45, calibratedLow: 0.3 });
    expect(effectiveThresholds(cfg, wide, { maxDrift: 0.2, minGap: 0.1 })).toEqual({
      high: 0.45,
      low: 0.3,
    });
    expect(effectiveThresholds(cfg, wide, rails)).toEqual(instance);
  });

  it('a gap breach → instance', () => {
    expect(
      effectiveThresholds(
        cfg,
        pref({ calibratedHigh: 0.52, calibratedLow: 0.45, calibratedAnchorHigh: 0.6 }),
        { maxDrift: 0.2, minGap: 0.1 },
      ),
    ).toEqual(instance);
  });
});
