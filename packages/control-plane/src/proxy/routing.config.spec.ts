import { DEFAULT_STRUCTURAL_WEIGHTS } from '@polyrouter/data-plane';
import { buildRoutingConfig, parseStructuralWeights, type RoutingEnv } from './routing.config';

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
});

describe('parseStructuralWeights', () => {
  it('returns the built-ins when absent/empty', () => {
    expect(parseStructuralWeights(undefined)).toEqual(DEFAULT_STRUCTURAL_WEIGHTS);
    expect(parseStructuralWeights('')).toEqual(DEFAULT_STRUCTURAL_WEIGHTS);
  });

  it('merges an override over the built-ins and normalizes to sum 1', () => {
    const w = parseStructuralWeights('{"size":0.5}');
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(w.size).toBeGreaterThan(DEFAULT_STRUCTURAL_WEIGHTS.size);
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
