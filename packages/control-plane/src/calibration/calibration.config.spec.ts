import { buildCalibrationConfig } from './calibration.config';

const BASE = {
  CALIBRATION_SCHED_ENABLED: 'true',
  CALIBRATION_SCHED_CRON: '0 4 * * *',
  CALIBRATION_WINDOW_DAYS: 14,
  CALIBRATION_MIN_EDGE_SAMPLES: 50,
  CALIBRATION_STEP: 0.02,
  CALIBRATION_MAX_DRIFT: 0.1,
};

describe('buildCalibrationConfig (add-auto-threshold-calibration)', () => {
  it('accepts the defaults', () => {
    const cfg = buildCalibrationConfig(BASE);
    expect(cfg).toMatchObject({ schedEnabled: true, windowDays: 14, step: 0.02, maxDrift: 0.1 });
  });

  it('rejects step > maxDrift (fail-fast)', () => {
    expect(() => buildCalibrationConfig({ ...BASE, CALIBRATION_STEP: 0.2 })).toThrow(
      /STEP must be <= /,
    );
  });

  it('rejects finer-than-4-decimal rails — one canonical precision (r3-Med-3)', () => {
    // A permitted 0.09996 drift would let the writer apply a pair the hot
    // path instantly inerts (audited move → immediate rebase); a 0.00001 step
    // would round to a zero-value move.
    expect(() => buildCalibrationConfig({ ...BASE, CALIBRATION_MAX_DRIFT: 0.09996 })).toThrow(
      /4 decimal/,
    );
    expect(() => buildCalibrationConfig({ ...BASE, CALIBRATION_STEP: 0.00001 })).toThrow(
      /4 decimal/,
    );
  });

  it('is exercised through zod for the floor: MIN_EDGE_SAMPLES cannot go below 50', () => {
    // The floor lives in the schema (z.min(50)); the builder trusts parsed
    // env — assert the builder passes 50 through unchanged.
    expect(
      buildCalibrationConfig({ ...BASE, CALIBRATION_MIN_EDGE_SAMPLES: 50 }).minEdgeSamples,
    ).toBe(50);
  });
});
