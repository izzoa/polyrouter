import type { PersistencePort, Principal, RoutingSettingsValue } from '@polyrouter/shared/server';
import {
  autoLayerCapability,
  buildRoutingConfig,
  type RoutingConfig,
  type RoutingEnv,
} from '../proxy/routing.config';
import { AutoLayersService } from './auto-layers.service';
import type { SemanticClassifierService } from '../semantic/semantic-classifier.service';

/** add-semantic-routing: the classifier is not ready in these tests. */
const SEMANTIC_OFF = { available: false } as SemanticClassifierService;

/** Fixture: a settings value with the calibration fields at their defaults
 * (add-auto-threshold-calibration) — these tests exercise the layer flags. */
function pref(v: {
  structuralEnabled: boolean;
  cascadeEnabled: boolean;
  semanticEnabled?: boolean;
}): RoutingSettingsValue {
  return {
    structuralEnabled: v.structuralEnabled,
    cascadeEnabled: v.cascadeEnabled,
    semanticEnabled: v.semanticEnabled ?? v.structuralEnabled,
    semanticLearningEnabled: false,
    semanticLearningEpoch: 0,
    semanticLearningGeneration: 0,
    calibrationEnabled: false,
    calibratedHigh: null,
    calibratedLow: null,
    calibratedAnchorHigh: null,
    calibratedAnchorLow: null,
    calibrationEpoch: 0,
  };
}

const BASE_ENV: RoutingEnv = {
  ROUTING_AUTO_LAYERS: '',
  ROUTING_STRUCTURAL_HIGH_THRESHOLD: 0.6,
  ROUTING_STRUCTURAL_LOW_THRESHOLD: 0.25,
  ROUTING_STRUCTURAL_BASELINE_ALPHA: 0.2,
  ROUTING_CASCADE_QUALITY_THRESHOLD: 0.5,
  ROUTING_CASCADE_CHEAP_TIMEOUT_MS: 30_000,
};

function cfg(autoLayers: string): RoutingConfig {
  return buildRoutingConfig({ ...BASE_ENV, ROUTING_AUTO_LAYERS: autoLayers });
}

const principal: Principal = { kind: 'user', userId: 'u1' };
const RAILS = { maxDrift: 0.1, minGap: 0.1 };
/** The calibration view block for an uncalibrated tenant (the layer tests). */
const UNCAL_VIEW = {
  enabled: false,
  calibratedHigh: null,
  calibratedLow: null,
  instanceHigh: 0.6,
  instanceLow: 0.25,
  effectiveHigh: 0.6,
  effectiveLow: 0.25,
};

/** A fake port whose routing-settings accessor is scripted per test. */
function fakePort(opts: {
  get?: RoutingSettingsValue | null;
  onUpsert?: (v: RoutingSettingsValue) => void;
}): PersistencePort {
  return {
    routingSettings: {
      get: () => Promise.resolve(opts.get ?? null),
      upsert: (
        _p: Principal,
        v: { structuralEnabled: boolean; cascadeEnabled: boolean; calibrationEnabled?: boolean },
      ) => {
        opts.onUpsert?.(v as unknown as RoutingSettingsValue);
        // The DB echoes the stored row (calibration fields at defaults).
        return Promise.resolve(
          pref({ structuralEnabled: v.structuralEnabled, cascadeEnabled: v.cascadeEnabled }),
        );
      },
    },
  } as unknown as PersistencePort;
}

describe('autoLayerCapability', () => {
  it('reports both layers when cascade is enabled (cascade implies structural)', () => {
    expect(autoLayerCapability(cfg('cascade'))).toEqual({ structural: true, cascade: true, semantic: false });
  });
  it('reports structural-only when only structural is enabled', () => {
    expect(autoLayerCapability(cfg('structural'))).toEqual({ structural: true, cascade: false, semantic: false });
  });
  it('reports neither when no smart layers are enabled', () => {
    expect(autoLayerCapability(cfg(''))).toEqual({ structural: false, cascade: false, semantic: false });
  });
});

describe('AutoLayersService.get — effective = capability × preference', () => {
  const cases: Array<{
    name: string;
    layers: string;
    pref: RoutingSettingsValue | null;
    expected: { structural: boolean; cascade: boolean };
  }> = [
    // No stored row → inherit-on: effective equals the capability.
    {
      name: 'no pref, both capable',
      layers: 'cascade',
      pref: null,
      expected: { structural: true, cascade: true },
    },
    {
      name: 'no pref, structural-only capable',
      layers: 'structural',
      pref: null,
      expected: { structural: true, cascade: false },
    },
    {
      name: 'no pref, none capable',
      layers: '',
      pref: null,
      expected: { structural: false, cascade: false },
    },
    // A preference only ever masks OFF a capable layer, never enables an incapable one.
    {
      name: 'pref off, both capable',
      layers: 'cascade',
      pref: pref({ structuralEnabled: false, cascadeEnabled: false }),
      expected: { structural: false, cascade: false },
    },
    {
      name: 'structural on / cascade off, both capable',
      layers: 'cascade',
      pref: pref({ structuralEnabled: true, cascadeEnabled: false }),
      expected: { structural: true, cascade: false },
    },
    {
      name: 'pref cascade-on but instance cannot cascade → masked off',
      layers: 'structural',
      pref: pref({ structuralEnabled: true, cascadeEnabled: true }),
      expected: { structural: true, cascade: false },
    },
    {
      name: 'pref on but instance disabled entirely → off',
      layers: '',
      pref: pref({ structuralEnabled: true, cascadeEnabled: true }),
      expected: { structural: false, cascade: false },
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const svc = new AutoLayersService(fakePort({ get: c.pref }), cfg(c.layers), RAILS, SEMANTIC_OFF);
      const view = await svc.get(principal);
      expect(view).toEqual({
        ...c.expected,
        structuralAvailable: autoLayerCapability(cfg(c.layers)).structural,
        cascadeAvailable: autoLayerCapability(cfg(c.layers)).cascade,
        semantic: false,
        semanticAvailable: false,
        semanticLearning: false,
        semanticLearningAvailable: false,
        calibration: UNCAL_VIEW,
      });
    });
  }
});

describe('AutoLayersService.set — normalizes cascade → structural', () => {
  it('forces structural on when cascade is requested with structural off', async () => {
    let stored: RoutingSettingsValue | undefined;
    const svc = new AutoLayersService(
      fakePort({ onUpsert: (v) => (stored = v) }),
      cfg('cascade'),
      RAILS,
      SEMANTIC_OFF,
    );
    const view = await svc.set(principal, { structural: false, cascade: true });
    expect(stored).toEqual({ structuralEnabled: true, cascadeEnabled: true });
    expect(view).toEqual({
      structural: true,
      cascade: true,
      structuralAvailable: true,
      cascadeAvailable: true,
      semantic: false,
      semanticAvailable: false,
      semanticLearning: false,
      semanticLearningAvailable: false,
      calibration: UNCAL_VIEW,
    });
  });

  it('stores a full opt-out verbatim', async () => {
    let stored: RoutingSettingsValue | undefined;
    const svc = new AutoLayersService(
      fakePort({ onUpsert: (v) => (stored = v) }),
      cfg('cascade'),
      RAILS,
      SEMANTIC_OFF,
    );
    await svc.set(principal, { structural: false, cascade: false });
    expect(stored).toEqual({ structuralEnabled: false, cascadeEnabled: false });
  });

  it('masks the returned cascade flag when the instance cannot cascade, though the row is stored', async () => {
    let stored: RoutingSettingsValue | undefined;
    const svc = new AutoLayersService(
      fakePort({ onUpsert: (v) => (stored = v) }),
      cfg('structural'), // cascade not available instance-wide
      RAILS,
      SEMANTIC_OFF,
    );
    const view = await svc.set(principal, { structural: true, cascade: true });
    expect(stored).toEqual({ structuralEnabled: true, cascadeEnabled: true });
    expect(view).toEqual({
      structural: true,
      cascade: false, // masked by capability
      structuralAvailable: true,
      cascadeAvailable: false,
      semantic: false,
      semanticAvailable: false,
      semanticLearning: false,
      semanticLearningAvailable: false,
      calibration: UNCAL_VIEW,
    });
  });
});
