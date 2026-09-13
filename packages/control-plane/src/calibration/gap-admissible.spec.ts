/** `gapAdmissible` and the tangent-rail fix (fix-tangent-gap-rail).
 *
 * `MIN_GAP` (0.1) EQUALS `2 * EDGE_WIDTH` (0.1). Before this change the gap rail
 * (`gap < minGap` -> refuse) and the halt rail (`high − w <= low + w` -> halt)
 * were exactly tangent and tied in opposite directions, so a pair landing on
 * exactly 0.1 was admitted by the writer and then permanently halted by the
 * calibrator. These specs pin the closed tie at both bounds, at both the shipped
 * constants and a LARGER configured `minGap` — the case where naming the rail
 * `> max(minGap, 2 * EDGE_WIDTH)` would have silently relaxed `>=` to `>`.
 */
import { effectiveThresholds } from '../proxy/routing.config';
import {
  calibrationHalted,
  gapAdmissible,
  EDGE_WIDTH,
  MIN_GAP,
  type CalibrationRails,
} from './calibration.config';

const rails: CalibrationRails = { maxDrift: 0.1, minGap: MIN_GAP };

describe('gapAdmissible', () => {
  it('pins the two constants that make this rail subtle', () => {
    // If either of these ever stops holding, the tangency this change closes
    // changes shape and every expectation below must be re-derived.
    expect(MIN_GAP).toBe(0.1);
    expect(2 * EDGE_WIDTH).toBe(0.1);
  });

  it('refuses a gap at EXACTLY the minimum — the bug this change closes', () => {
    expect(gapAdmissible(0.0999, rails)).toBe(false);
    expect(gapAdmissible(0.1, rails)).toBe(false); // was admitted, then halted
    expect(gapAdmissible(0.1001, rails)).toBe(true);
  });

  it('preserves >= for a LARGER configured minimum gap', () => {
    // The second bound (0.1) is slack here, so the first binds — and it must
    // stay inclusive. `> max(minGap, 2 * EDGE_WIDTH)` would reject 0.15 and
    // silently narrow the admissible region for an operator-set knob.
    const wide: CalibrationRails = { maxDrift: 0.1, minGap: 0.15 };
    expect(gapAdmissible(0.1499, wide)).toBe(false);
    expect(gapAdmissible(0.15, wide)).toBe(true);
    expect(gapAdmissible(0.2, wide)).toBe(true);
  });

  it('compares on the canonical 4-decimal precision', () => {
    // 0.48 − 0.38 is 0.09999999999999998 in binary floating point; without the
    // rounding this rail would inert a pair the calibrator legitimately wrote.
    expect(gapAdmissible(0.58 - 0.48, rails)).toBe(false); // exactly 0.1 -> refused
    expect(gapAdmissible(0.6 - 0.25, rails)).toBe(true);
  });
});

describe('effectiveThresholds retroactively inerts a tangent pair', () => {
  const instance = { high: 0.6, low: 0.25 };
  const stored = (high: number, low: number): Parameters<typeof effectiveThresholds>[1] => ({
    calibratedHigh: high,
    calibratedLow: low,
    calibratedAnchorHigh: 0.6,
    calibratedAnchorLow: 0.25,
  });

  it('returns the instance defaults for a pair at exactly the minimum gap', () => {
    // Such a pair cannot be written any more, but one admitted by an older
    // writer is still in storage. Reading it as inert is what makes this fix
    // retroactive without a migration: routing falls back, the halt clears,
    // and the next run rebases the row through the existing hygiene path.
    expect(effectiveThresholds(instance, stored(0.5, 0.4), rails)).toEqual(instance);
  });

  it('still returns a rail-clean pair unchanged', () => {
    expect(effectiveThresholds(instance, stored(0.5, 0.35), rails)).toEqual({
      high: 0.5,
      low: 0.35,
    });
    expect(effectiveThresholds(instance, stored(0.58, 0.25), rails)).toEqual({
      high: 0.58,
      low: 0.25,
    });
  });

  it('un-halts the tenant, because the inert pair degrades to a clean one', () => {
    // The whole point of the retroactive arm. Before: the stored 0.1-gap pair
    // is effective, so the zones touch and the tenant is halted with no way
    // out. After: the pair is inert, the effective pair is the instance
    // default, and calibration resumes.
    const eff = effectiveThresholds(instance, stored(0.5, 0.4), rails);
    expect(calibrationHalted(instance, eff, rails)).toBe(false);
    // Directly evaluating the frozen pair still reports halted — the rule did
    // not change, the pair simply stopped being effective.
    expect(calibrationHalted(instance, { high: 0.5, low: 0.4 }, rails)).toBe(true);
  });
});
