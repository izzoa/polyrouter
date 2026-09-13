/** The three-level resolution chain (add-per-agent-calibration, tasks 2.1-2.3, 2.6).
 *
 * instance defaults -> tenant pair -> agent pair, with the SAME degrade
 * contract at each hop. Two properties carry most of the weight:
 *
 *  1. An unusable AGENT pair falls to the TENANT pair, never past it to the
 *     instance defaults. Skipping a level would discard a tenant's calibration
 *     because one of its agents went stale — the opposite of degrading.
 *  2. Drift is bounded from the tenant anchor AND globally from the instance
 *     defaults. Anchoring to the tenant does not prevent the caps compounding,
 *     it creates the possibility; the global bound is what closes it.
 */
import {
  effectiveThresholds,
  resolveThresholds,
  type CalibratedPairRow,
} from './routing.config';

const INSTANCE = { high: 0.6, low: 0.25 };
const rails = { maxDrift: 0.1, minGap: 0.1 };

/** A stored pair anchored to `[ah, al]`. */
const pair = (h: number, l: number, ah: number, al: number): CalibratedPairRow => ({
  calibratedHigh: h,
  calibratedLow: l,
  calibratedAnchorHigh: ah,
  calibratedAnchorLow: al,
});

/** A tenant pair 0.55/0.30 — one legal contraction from the instance defaults. */
const TENANT = pair(0.55, 0.3, 0.6, 0.25);

describe('resolveThresholds — the chain', () => {
  it('returns the instance defaults when neither level has a pair', () => {
    expect(resolveThresholds(INSTANCE, null, null, rails)).toEqual({
      high: 0.6,
      low: 0.25,
      scope: 'instance',
    });
  });

  it('returns the tenant pair when only the tenant has one', () => {
    expect(resolveThresholds(INSTANCE, TENANT, null, rails)).toEqual({
      high: 0.55,
      low: 0.3,
      scope: 'tenant',
    });
  });

  it('returns the agent pair when it is a legal contraction of the tenant pair', () => {
    const agent = pair(0.52, 0.32, 0.55, 0.3); // anchored to the TENANT pair
    expect(resolveThresholds(INSTANCE, TENANT, agent, rails)).toEqual({
      high: 0.52,
      low: 0.32,
      scope: 'agent',
    });
  });

  it('lets an agent hold a pair while its tenant holds none', () => {
    // Bootstrap: an unpromoted tenant's agents anchor to the instance defaults.
    const agent = pair(0.55, 0.3, 0.6, 0.25);
    expect(resolveThresholds(INSTANCE, null, agent, rails)).toEqual({
      high: 0.55,
      low: 0.3,
      scope: 'agent',
    });
  });
});

describe('an unusable AGENT pair lands on the TENANT pair, never the instance', () => {
  const expectTenant = (agent: CalibratedPairRow | null): void => {
    expect(resolveThresholds(INSTANCE, TENANT, agent, rails)).toEqual({
      high: 0.55,
      low: 0.3,
      scope: 'tenant',
    });
  };

  it('absent', () => expectTenant(null));

  it('partial', () => {
    expectTenant({ ...pair(0.52, 0.32, 0.55, 0.3), calibratedAnchorLow: null });
    expectTenant({ ...pair(0.52, 0.32, 0.55, 0.3), calibratedLow: null });
  });

  it('non-finite', () => {
    expectTenant(pair(Number.NaN, 0.32, 0.55, 0.3));
    expectTenant(pair(Number.POSITIVE_INFINITY, 0.32, 0.55, 0.3));
  });

  it('out of range', () => {
    expectTenant(pair(1.4, 0.32, 0.55, 0.3));
    expectTenant(pair(0.52, -0.2, 0.55, 0.3));
  });

  it('low >= high', () => expectTenant(pair(0.32, 0.52, 0.55, 0.3)));

  it('anchor mismatch — the tenant moved under it', () => {
    // Anchored to a tenant pair that is no longer effective. This is the hop
    // that supplies automatic demotion: a tenant move inerts every agent pair
    // beneath it, and hygiene rebases them.
    expectTenant(pair(0.52, 0.32, 0.58, 0.27));
  });

  it('expansion beyond its anchor — contraction only', () => {
    // The child can only turn a tenant-AMBIGUOUS score confident. It can never
    // turn a tenant-confident score back into ambiguous.
    expectTenant(pair(0.6, 0.3, 0.55, 0.3));
    expectTenant(pair(0.55, 0.25, 0.55, 0.3));
  });

  it('drift beyond the cap FROM THE TENANT ANCHOR', () => {
    // 0.55 -> 0.44 is 0.11, over the 0.1 cap measured at this hop.
    expectTenant(pair(0.44, 0.3, 0.55, 0.3));
  });

  it('a tangent gap — both bounds of the shared rail apply here too', () => {
    // gap exactly 0.1 == 2 * EDGE_WIDTH (fix-tangent-gap-rail).
    expectTenant(pair(0.45, 0.35, 0.55, 0.3));
  });
});

describe('compound drift is refused (task 2.2)', () => {
  it('tenant at +cap and agent at +cap beyond it is inert', () => {
    // Tenant drifts the full 0.1 on the high edge: 0.6 -> 0.5.
    const tenantAtCap = pair(0.5, 0.25, 0.6, 0.25);
    // The agent then drifts a further 0.1 from ITS anchor: 0.5 -> 0.4.
    // Legal at this hop (0.1 is not > 0.1) but 0.2 from the instance defaults.
    const agentAtCap = pair(0.4, 0.25, 0.5, 0.25);

    // Sanity: the agent pair passes every PER-HOP rail, so only the global
    // bound can be rejecting it. Without that assertion this test would pass
    // for the wrong reason.
    expect(effectiveThresholds({ high: 0.5, low: 0.25 }, agentAtCap, rails)).toEqual({
      high: 0.4,
      low: 0.25,
    });

    expect(resolveThresholds(INSTANCE, tenantAtCap, agentAtCap, rails)).toEqual({
      high: 0.5,
      low: 0.25,
      scope: 'tenant',
    });
  });

  it('accepts an agent exactly AT the global cap, measured from the instance', () => {
    const tenantAtCap = pair(0.5, 0.25, 0.6, 0.25); // 0.1 drift, at the cap
    const agentSame = pair(0.5, 0.3, 0.5, 0.25); // high unchanged; low +0.05
    // Global: high drift 0.1 (at cap, allowed), low drift 0.05. Both within.
    expect(resolveThresholds(INSTANCE, tenantAtCap, agentSame, rails)).toEqual({
      high: 0.5,
      low: 0.3,
      scope: 'agent',
    });
  });

  it('bounds the LOW edge globally too', () => {
    const tenantAtCap = pair(0.6, 0.35, 0.6, 0.25); // low +0.1, at the cap
    const agentFurther = pair(0.6, 0.45, 0.6, 0.35); // a further +0.1 -> 0.2 total
    expect(resolveThresholds(INSTANCE, tenantAtCap, agentFurther, rails)).toEqual({
      high: 0.6,
      low: 0.35,
      scope: 'tenant',
    });
  });
});

describe('a null agent quad changes nothing (task 2.3)', () => {
  const nullQuad = pair(null as unknown as number, null as unknown as number, 0.6, 0.25);
  const cases: (CalibratedPairRow | null)[] = [
    null,
    TENANT,
    pair(0.58, 0.25, 0.6, 0.25),
    pair(0.5, 0.35, 0.6, 0.25),
    pair(0.44, 0.3, 0.6, 0.25), // over-drift
    pair(0.45, 0.35, 0.6, 0.25), // tangent gap
    pair(0.52, 0.32, 0.58, 0.27), // anchor mismatch
    pair(1.4, 0.3, 0.6, 0.25), // out of range
    { ...TENANT, calibratedAnchorLow: null }, // partial
  ];

  it.each(cases.map((c, i) => [i, c] as const))(
    'case %i matches effectiveThresholds byte for byte',
    (_i, tenantPref) => {
      const before = effectiveThresholds(INSTANCE, tenantPref, rails);
      for (const agentPref of [null, nullQuad]) {
        const after = resolveThresholds(INSTANCE, tenantPref, agentPref, rails);
        expect({ high: after.high, low: after.low }).toEqual(before);
      }
    },
  );
});

describe('a tenant settings-read fault inerts the agent pair too (task 2.6)', () => {
  it('falls all the way to the instance defaults', () => {
    // The read that carries the tenant pair failed, so `tenantPref` is null and
    // the agent's anchor cannot be validated against anything. The agent pair
    // is anchored to 0.55/0.30, which is NOT the instance defaults, so it is
    // inert by the ordinary anchor rule — no special case needed.
    const agent = pair(0.52, 0.32, 0.55, 0.3);
    expect(resolveThresholds(INSTANCE, null, agent, rails)).toEqual({
      high: 0.6,
      low: 0.25,
      scope: 'instance',
    });
  });

  it('does NOT silently promote an agent pair that happens to fit', () => {
    // The guard is the anchor, not the values: a pair whose numbers would be a
    // legal contraction of the instance defaults still needs its anchor to say
    // so. Here it claims a tenant pair that is not in effect.
    const agent = pair(0.55, 0.3, 0.58, 0.27);
    expect(resolveThresholds(INSTANCE, null, agent, rails).scope).toBe('instance');
  });
});
