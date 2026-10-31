import { describe, expect, it } from 'vitest';
import type { AutoLayers } from './api';
import {
  layerSwitchState,
  semanticUnavailableHint,
  semanticWorkloadMissingHalf,
  structuralLayers,
} from './autoLayerHints';
import { DEFAULT_CALIBRATION } from '../test/fakeClient';

/** A fully capable, fully enabled view — each case knocks out one half. */
function layers(over: Partial<AutoLayers> = {}): AutoLayers {
  return {
    structural: true,
    cascade: true,
    semantic: true,
    semanticAvailable: true,
    semanticFlagEnabled: true,
    semanticEmbedderReady: true,
    semanticClassifierReady: true,
    semanticWorkloadAvailable: true,
    semanticWorkload: true,
    semanticLearning: false,
    semanticLearningAvailable: true,
    structuralAvailable: true,
    cascadeAvailable: true,
    calibration: DEFAULT_CALIBRATION,
    ...over,
  };
}

/** An older server: the capability split fields are absent, not false. */
function olderServer(over: Partial<AutoLayers> = {}): AutoLayers {
  const al = layers(over);
  delete al.semanticFlagEnabled;
  delete al.semanticEmbedderReady;
  delete al.semanticClassifierReady;
  delete al.semanticWorkloadAvailable;
  delete al.semanticWorkload;
  return al;
}

/** The env/config names a hint can point at — each one is a "half". */
const FLAG = 'ROUTING_AUTO_LAYERS';
const PATH = 'SEMANTIC_MODEL_PATH';
const IMAGE = '-semantic image';

describe('semanticWorkloadMissingHalf', () => {
  it('is empty when the semantic workload source is effective', () => {
    expect(semanticWorkloadMissingHalf(layers())).toBe('');
  });

  it('says the state is unknown before the view loads — never names a half', () => {
    expect(semanticWorkloadMissingHalf(null)).toBe('semantic module state unknown');
  });

  it('names the flag when it is the missing half', () => {
    const hint = semanticWorkloadMissingHalf(
      layers({ semanticWorkload: false, semanticFlagEnabled: false }),
    );
    expect(hint).toBe('add semantic to ROUTING_AUTO_LAYERS');
    expect(hint).not.toContain(PATH);
  });

  it('names the model when no embedder loaded', () => {
    const hint = semanticWorkloadMissingHalf(
      layers({
        semanticWorkload: false,
        semanticEmbedderReady: false,
        semanticClassifierReady: false,
      }),
    );
    expect(hint).toBe('no ready model (SEMANTIC_MODEL_PATH / the -semantic image)');
    expect(hint).not.toContain(FLAG);
  });

  it('embedder loaded, centroids failed: names the centroid build, never the path', () => {
    const hint = semanticWorkloadMissingHalf(
      layers({ semanticWorkload: false, semanticClassifierReady: false }),
    );
    expect(hint).toBe('the band centroids did not build under this model (see the boot log)');
    expect(hint).not.toContain(PATH);
    expect(hint).not.toContain(IMAGE);
    expect(hint).not.toContain(FLAG);
  });

  it('names the workload anchors when the classifier is ready but they did not build', () => {
    const hint = semanticWorkloadMissingHalf(
      layers({ semanticWorkload: false, semanticWorkloadAvailable: false }),
    );
    expect(hint).toBe('the workload anchors did not build under this model (see the boot log)');
    expect(hint).not.toContain(PATH);
    expect(hint).not.toContain(FLAG);
  });

  it("names the tenant's toggle when the capability is whole but the layer is off", () => {
    expect(semanticWorkloadMissingHalf(layers({ semanticWorkload: false, semantic: false }))).toBe(
      'the semantic layer is toggled off for this tenant',
    );
  });

  it('falls back to a bare "not effective" when every named half is satisfied', () => {
    expect(semanticWorkloadMissingHalf(layers({ semanticWorkload: false }))).toBe('not effective');
  });

  it('an older server (split fields absent) degrades to naming the flag', () => {
    expect(semanticWorkloadMissingHalf(olderServer())).toBe('add semantic to ROUTING_AUTO_LAYERS');
  });
});

describe('semanticUnavailableHint', () => {
  const off = { semantic: false, semanticAvailable: false } as const;

  it('model ready, flag off: points ONLY at the flag', () => {
    const hint = semanticUnavailableHint(
      layers({ ...off, semanticFlagEnabled: false, semanticClassifierReady: true }),
    );
    expect(hint).toBe('off instance-wide — model loaded; add semantic to ROUTING_AUTO_LAYERS');
    expect(hint).not.toContain(PATH);
  });

  it('flag set, no bundle: points ONLY at the model half', () => {
    const hint = semanticUnavailableHint(
      layers({ ...off, semanticEmbedderReady: false, semanticClassifierReady: false }),
    );
    expect(hint).toBe(
      'off instance-wide — no ready model; check SEMANTIC_MODEL_PATH + boot logs, or run the -semantic image',
    );
    expect(hint).not.toContain(FLAG);
  });

  it('embedder loaded, centroids failed, flag set: names the centroids — not the path, image or flag', () => {
    const hint = semanticUnavailableHint(layers({ ...off, semanticClassifierReady: false }));
    expect(hint).toBe(
      'off instance-wide — model loaded, but its centroids did not build; see the boot log (the model path is fine)',
    );
    expect(hint).not.toContain(PATH);
    expect(hint).not.toContain(IMAGE);
    expect(hint).not.toContain(FLAG);
  });

  it('embedder loaded, centroids failed, flag off: names the centroids AND the flag, never the path', () => {
    const hint = semanticUnavailableHint(
      layers({ ...off, semanticFlagEnabled: false, semanticClassifierReady: false }),
    );
    expect(hint).toBe(
      'off instance-wide — model loaded, but its centroids did not build; see the boot log, and add semantic to ROUTING_AUTO_LAYERS',
    );
    expect(hint).not.toContain(PATH);
  });

  it('neither half (or an older server without the split): names both', () => {
    const both =
      'off instance-wide — optional module; needs SEMANTIC_MODEL_PATH (or the -semantic image) + semantic in ROUTING_AUTO_LAYERS';
    expect(
      semanticUnavailableHint(
        layers({
          ...off,
          semanticFlagEnabled: false,
          semanticEmbedderReady: false,
          semanticClassifierReady: false,
        }),
      ),
    ).toBe(both);
    expect(semanticUnavailableHint(olderServer(off))).toBe(both);
  });
});

describe('structuralLayers', () => {
  it('lists L1, L2, L3 with their unchanged names, tags and copy', () => {
    const rows = structuralLayers(layers());
    expect(rows.map((r) => [r.id, r.name, r.tag])).toEqual([
      ['structural', 'L1 · Structural', '<1ms, local'],
      ['semantic', 'L2 · Semantic', 'local embed'],
      ['cascade', 'L3 · Cascade', 'cheap-first'],
    ]);
    expect(rows[0]?.desc).toBe(
      'Language-neutral features; system prompts fingerprinted & subtracted.',
    );
    expect(rows[2]?.desc).toBe(
      'Ambiguous requests try the cheap model, escalate on a failed quality check.',
    );
  });

  it('reads each switch from the effective flag and its capability', () => {
    const rows = structuralLayers(
      layers({ cascade: false, semantic: false, semanticAvailable: false }),
    );
    expect(rows.map((r) => [r.on, r.available])).toEqual([
      [true, true],
      [false, false],
      [false, true],
    ]);
    expect(rows.map((r) => layerSwitchState(r).kind)).toEqual(['on', 'unavailable', 'off']);
  });

  it('an unavailable layer carries its hint — L2 the missing-half one', () => {
    const rows = structuralLayers(
      layers({
        structuralAvailable: false,
        structural: false,
        semantic: false,
        semanticAvailable: false,
        semanticFlagEnabled: false,
      }),
    );
    expect(layerSwitchState(rows[0]!)).toEqual({
      kind: 'unavailable',
      hint: 'off instance-wide (ROUTING_AUTO_LAYERS)',
    });
    expect(layerSwitchState(rows[1]!)).toEqual({
      kind: 'unavailable',
      hint: 'off instance-wide — model loaded; add semantic to ROUTING_AUTO_LAYERS',
    });
  });

  it('a null view is loading — never "off instance-wide"', () => {
    const rows = structuralLayers(null);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.loading).toBe(true);
      expect(r.unavailableHint).toBe('');
      expect(layerSwitchState(r)).toEqual({ kind: 'loading' });
    }
    expect(JSON.stringify(rows)).not.toContain('off instance-wide');
  });

  it('a loaded view is never loading — even when every layer is unavailable', () => {
    const rows = structuralLayers(
      layers({
        structural: false,
        cascade: false,
        semantic: false,
        structuralAvailable: false,
        cascadeAvailable: false,
        semanticAvailable: false,
      }),
    );
    expect(rows.every((r) => !r.loading)).toBe(true);
    expect(rows.every((r) => layerSwitchState(r).kind === 'unavailable')).toBe(true);
  });
});
