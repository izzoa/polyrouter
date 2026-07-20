import { describe, expect, it } from 'vitest';
import { formatRoutingTarget, parseRoutingTarget, type RoutingTarget } from '../src/routing-target';
import { TIER_KEY_PATTERN } from '../src/routing-constants';

describe('parseRoutingTarget / formatRoutingTarget', () => {
  it('parses tier and model targets to a discriminated value', () => {
    expect(parseRoutingTarget('tier:default')).toEqual({ kind: 'tier', key: 'default' });
    expect(parseRoutingTarget('model:m_123')).toEqual({ kind: 'model', id: 'm_123' });
  });

  it('round-trips both kinds byte-for-byte', () => {
    const cases: RoutingTarget[] = [
      { kind: 'tier', key: 'fast-tier_2' },
      { kind: 'model', id: 'prov/model:with:colons' },
    ];
    for (const t of cases) {
      expect(parseRoutingTarget(formatRoutingTarget(t))).toEqual(t);
    }
  });

  it('splits only on the first colon so model ids keep embedded colons', () => {
    expect(parseRoutingTarget('model:openrouter/free-model:free')).toEqual({
      kind: 'model',
      id: 'openrouter/free-model:free',
    });
  });

  it('returns null (never throws) for malformed input', () => {
    for (const bad of ['', 'default', 'tier', 'tier:', 'model:', 'agent:x', ' tier:default']) {
      expect(parseRoutingTarget(bad)).toBeNull();
    }
  });
});

describe('TIER_KEY_PATTERN', () => {
  it('accepts lowercase slugs and rejects unsafe keys', () => {
    for (const ok of ['default', 'a', 'fast-1', 'a_b', '0tier']) {
      expect(TIER_KEY_PATTERN.test(ok)).toBe(true);
    }
    for (const bad of ['', 'Default', 'has space', 'tier!', '-lead', 'a'.repeat(65)]) {
      expect(TIER_KEY_PATTERN.test(bad)).toBe(false);
    }
  });
});
