import type { RouteDecision, StructuralVerdict } from '@polyrouter/data-plane';
import { withFallthroughSuffix } from './proxy.service';

const decision = (layer: string): RouteDecision =>
  ({
    decisionLayer: layer,
    routingReason: 'auto \u2192 default tier',
    tierKey: 'default',
    matchedHeader: null,
    chain: [],
  }) as unknown as RouteDecision;

const verdict: StructuralVerdict = {
  band: 'ambiguous',
  score: 0.41,
  reason: 'structural:ambiguous score=0.41',
  declared: false,
};

describe('withFallthroughSuffix (add-auto-decision-telemetry) \u2014 the FINAL-cascade gate', () => {
  it('appends the verdict reason when the default stands with no FINAL cascade', () => {
    const d = withFallthroughSuffix(decision('default'), verdict, undefined, false);
    expect(d.routingReason).toBe('auto \u2192 default tier; structural:ambiguous score=0.41');
    // The suffix spread preserves the rest of the decision \u2014 matchedHeader
    // included (add-routing-header-visibility).
    expect(d.matchedHeader).toBeNull();
  });

  it('does NOT append when a cascade was finally constructed \u2014 even though a plan alone would have existed', () => {
    // Pins the gate against regressing to plan-null keying (r2-Medium-2): a
    // resolved plan whose bundles FAILED to materialize passes hasCascade=false
    // (suffix applies); a materialized cascade passes true (no suffix).
    expect(withFallthroughSuffix(decision('default'), verdict, undefined, true).routingReason).toBe(
      'auto \u2192 default tier',
    );
    expect(withFallthroughSuffix(decision('default'), verdict, undefined, false).routingReason).toContain(
      '; structural:ambiguous',
    );
  });

  it('does NOT append on a non-default decision or without a verdict, and never double-appends', () => {
    expect(withFallthroughSuffix(decision('structural'), verdict, undefined, false).routingReason).toBe(
      'auto \u2192 default tier',
    );
    expect(withFallthroughSuffix(decision('default'), undefined, undefined, false).routingReason).toBe(
      'auto \u2192 default tier',
    );
    const once = withFallthroughSuffix(decision('default'), verdict, undefined, false);
    expect(withFallthroughSuffix(once, undefined, undefined, false).routingReason).toBe(once.routingReason);
  });
});
