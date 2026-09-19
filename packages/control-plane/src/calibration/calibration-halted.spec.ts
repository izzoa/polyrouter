/** `calibrationHalted` (fix-calibration-evidence-honesty).
 *
 * The predicate the calibrator uses to decline a tenant outright, extracted so
 * the read-time evidence report cannot describe a different rule than the one
 * that runs. Tested directly because — as the e2e beside it pins — the
 * zones-touching arm is UNREACHABLE by calibration drift under the default
 * rails: from 0.6/0.25 with maxDrift 0.1 a side the tightest reachable gap is
 * 0.15, while the zones meet at 0.10. It is reachable only by configuring the
 * instance thresholds closer together, which is the OTHER arm.
 */
import { calibrationHalted, EDGE_WIDTH, MIN_GAP } from './calibration.config';

const rails = { maxDrift: 0.1, minGap: MIN_GAP };

describe('calibrationHalted', () => {
  it('is false for the instance defaults', () => {
    expect(calibrationHalted({ high: 0.6, low: 0.25 }, { high: 0.6, low: 0.25 }, rails)).toBe(
      false,
    );
  });

  it('halts on a degenerate INSTANCE pair narrower than the minimum gap', () => {
    // The reachable arm: an operator configures the thresholds too close.
    expect(calibrationHalted({ high: 0.5, low: 0.45 }, { high: 0.5, low: 0.45 }, rails)).toBe(true);
    // A pair at EXACTLY the minimum gap clears arm 1 (0.10 is not < 0.10) and is
    // then caught by arm 2 — because MIN_GAP (0.1) equals 2 x EDGE_WIDTH (0.1),
    // so the narrowest gap the rail permits is precisely the one whose zones
    // meet. The two rails are exactly tangent; a usable pair needs gap > 0.10.
    expect(calibrationHalted({ high: 0.5, low: 0.4 }, { high: 0.5, low: 0.4 }, rails)).toBe(true);
    expect(calibrationHalted({ high: 0.52, low: 0.4 }, { high: 0.52, low: 0.4 }, rails)).toBe(
      false,
    );
  });

  it('halts when the EFFECTIVE zones touch, inclusive at the boundary', () => {
    // Zones are [high−w, high) and (low, low+w]; equality means one shared score.
    const instance = { high: 0.8, low: 0.1 }; // wide enough that arm 1 never fires
    // gap exactly 2*EDGE_WIDTH -> they meet at one score -> halted.
    expect(calibrationHalted(instance, { high: 0.5, low: 0.5 - 2 * EDGE_WIDTH }, rails)).toBe(true);
    // One step wider -> they do not meet.
    expect(
      calibrationHalted(instance, { high: 0.5, low: 0.5 - 2 * EDGE_WIDTH - 0.01 }, rails),
    ).toBe(false);
  });

  it('rounds to 4dp, matching the calibrator', () => {
    // Float noise at the boundary must not flip the verdict.
    const instance = { high: 0.8, low: 0.1 };
    expect(calibrationHalted(instance, { high: 0.3, low: 0.2 }, rails)).toBe(true);
  });
});
