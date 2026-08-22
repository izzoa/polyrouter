import { describe, expect, it } from 'vitest';
import {
  STRUCTURAL_WORKLOAD_CLASSES,
  STRUCTURAL_WORKLOAD_CLASSIFIER_VERSION,
  TIER_KEY_PATTERN,
  WORKLOAD_CLASSES,
  WORKLOAD_NONE,
  WORKLOAD_SOURCES,
  WORKLOAD_TAXONOMY_VERSION,
} from '../src/routing-constants';
import * as root from '../src';
import * as server from '../src/server';

/** add-workload-telemetry task 1.1 — the taxonomy is ONE shared contract. */
describe('workload taxonomy (add-workload-telemetry)', () => {
  it('defines exactly the five v1 classes, in a stable order', () => {
    expect([...WORKLOAD_CLASSES]).toEqual(['code', 'research', 'vision', 'structured', 'writing']);
    expect(WORKLOAD_TAXONOMY_VERSION).toBe('v1');
    expect(STRUCTURAL_WORKLOAD_CLASSIFIER_VERSION).toBe('c1');
  });

  it('`none` is the telemetry-only value — never a class', () => {
    expect(WORKLOAD_NONE).toBe('none');
    expect((WORKLOAD_CLASSES as readonly string[]).includes(WORKLOAD_NONE)).toBe(false);
  });

  it('the structural source can emit exactly code / vision / structured (a strict subset)', () => {
    expect([...STRUCTURAL_WORKLOAD_CLASSES]).toEqual(['code', 'vision', 'structured']);
    for (const c of STRUCTURAL_WORKLOAD_CLASSES) {
      expect((WORKLOAD_CLASSES as readonly string[]).includes(c)).toBe(true);
    }
    expect((STRUCTURAL_WORKLOAD_CLASSES as readonly string[]).includes('research')).toBe(false);
    expect((STRUCTURAL_WORKLOAD_CLASSES as readonly string[]).includes('writing')).toBe(false);
  });

  it('sources are exactly structural | semantic', () => {
    expect([...WORKLOAD_SOURCES]).toEqual(['structural', 'semantic']);
  });

  it('every class key (and `none`) is a valid tier-key slug — header-safe, stable', () => {
    for (const c of [...WORKLOAD_CLASSES, WORKLOAD_NONE]) {
      expect(TIER_KEY_PATTERN.test(c)).toBe(true);
    }
  });

  it('is exported from both the root and the server entrypoints (the RULE_MATCH_TYPES precedent)', () => {
    expect(root.WORKLOAD_CLASSES).toBe(WORKLOAD_CLASSES);
    expect(server.WORKLOAD_CLASSES).toBe(WORKLOAD_CLASSES);
    expect(root.WORKLOAD_NONE).toBe('none');
    expect(server.STRUCTURAL_WORKLOAD_CLASSES).toBe(STRUCTURAL_WORKLOAD_CLASSES);
    expect(root.WORKLOAD_SOURCES).toBe(WORKLOAD_SOURCES);
  });
});
