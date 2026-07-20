import type {
  CalibrationEdgeStats,
  CalibrationSweepTenant,
  PersistencePort,
  RoutingSettingsValue,
  ThresholdCalibrationEventInput,
  ThresholdCalibrationEventRowView,
} from '@polyrouter/shared/server';
import type { CalibrationConfig, CalibrationRails } from './calibration.config';
import { runCalibrationOccurrence } from './calibration.run';

const CFG: CalibrationConfig = {
  schedEnabled: true,
  cron: '0 4 * * *',
  windowDays: 14,
  minEdgeSamples: 50,
  step: 0.02,
  maxDrift: 0.1,
};
const RAILS: CalibrationRails = { maxDrift: 0.1, minGap: 0.1 };
const STRUCTURAL = { high: 0.6, low: 0.25 };
const NOW = Date.parse('2026-07-20T04:00:00.000Z');
const DAY = 86_400_000;

const uncalibrated = (over: Partial<RoutingSettingsValue> = {}): RoutingSettingsValue => ({
  structuralEnabled: true,
  cascadeEnabled: true,
  calibrationEnabled: true,
  calibratedHigh: null,
  calibratedLow: null,
  calibratedAnchorHigh: null,
  calibratedAnchorLow: null,
  calibrationEpoch: 0,
  ...over,
});

interface SetCall {
  owner: string;
  quad: { high: number; low: number; anchorHigh: number; anchorLow: number } | null;
  expected: unknown;
  events: ThresholdCalibrationEventInput[];
}

/** A fake port covering exactly the surfaces the occurrence touches. */
function fakePort(opts: {
  enabled?: CalibrationSweepTenant[];
  stored?: CalibrationSweepTenant[];
  stats?: (owner: string) => CalibrationEdgeStats;
  recentEvents?: ThresholdCalibrationEventRowView[];
  setResult?: boolean;
  statsThrows?: (owner: string) => boolean;
}): { port: PersistencePort; calls: SetCall[]; statsArgs: unknown[] } {
  const calls: SetCall[] = [];
  const statsArgs: unknown[] = [];
  const port = {
    routingSettings: {
      listCalibrationEnabled: () => Promise.resolve(opts.enabled ?? []),
      listWithCalibratedPair: () => Promise.resolve(opts.stored ?? []),
      setCalibrated: (
        principal: { userId: string },
        quad: SetCall['quad'],
        expected: unknown,
        events:
          | ThresholdCalibrationEventInput
          | ThresholdCalibrationEventInput[]
          | ((v: RoutingSettingsValue) => ThresholdCalibrationEventInput),
      ) => {
        const resolved = typeof events === 'function' ? events(uncalibrated()) : events;
        calls.push({
          owner: principal.userId,
          quad,
          expected,
          events: Array.isArray(resolved) ? resolved : [resolved],
        });
        return Promise.resolve(opts.setResult ?? true);
      },
    },
    calibrationEvents: {
      list: () => Promise.resolve(opts.recentEvents ?? []),
    },
    analytics: {
      calibrationStats: (p: { userId: string }, _range: unknown, args: unknown) => {
        if (opts.statsThrows?.(p.userId) === true) {
          return Promise.reject(new Error('stats boom'));
        }
        statsArgs.push(args);
        return Promise.resolve(
          opts.stats?.(p.userId) ?? {
            highEdge: { samples: 0, failures: 0 },
            lowEdge: { samples: 0, failures: 0 },
          },
        );
      },
    },
  } as unknown as PersistencePort;
  return { port, calls, statsArgs };
}

const tenant = (owner: string, v: RoutingSettingsValue): CalibrationSweepTenant => ({
  ownerUserId: owner,
  value: v,
});
const silent = { warn: () => {}, log: () => {} };

describe('runCalibrationOccurrence (add-auto-threshold-calibration)', () => {
  it('a hot high edge moves one step with anchor + a chained event', async () => {
    const { port, calls, statsArgs } = fakePort({
      enabled: [tenant('a', uncalibrated({ calibrationEpoch: 3 }))],
      stats: () => ({
        highEdge: { samples: 57, failures: 43 },
        lowEdge: { samples: 0, failures: 0 },
      }),
    });
    const sum = await runCalibrationOccurrence(port, STRUCTURAL, CFG, RAILS, NOW, silent);
    expect(sum).toEqual({ tenants: 1, moves: 1, rebases: 0, skips: 0 });
    const call = calls[0]!;
    expect(call.quad).toEqual({ high: 0.58, low: 0.25, anchorHigh: 0.6, anchorLow: 0.25 });
    expect(call.events).toHaveLength(1);
    expect(call.events[0]).toMatchObject({
      trigger: 'calibrator',
      edge: 'high',
      oldHigh: 0.6,
      oldLow: 0.25,
      newHigh: 0.58,
      newLow: 0.25,
      edgeSamples: 57,
      edgeFailures: 43,
    });
    // Decision-time freshness: the stats query is pinned to the tenant epoch.
    expect(statsArgs[0]).toMatchObject({ epoch: 3, high: 0.6, low: 0.25, edgeWidth: 0.05 });
  });

  it('a quiet low edge raises low one step', async () => {
    const { port, calls } = fakePort({
      enabled: [tenant('a', uncalibrated())],
      stats: () => ({
        highEdge: { samples: 0, failures: 0 },
        lowEdge: { samples: 60, failures: 3 },
      }),
    });
    const sum = await runCalibrationOccurrence(port, STRUCTURAL, CFG, RAILS, NOW, silent);
    expect(sum.moves).toBe(1);
    expect(calls[0]!.quad).toEqual({ high: 0.6, low: 0.27, anchorHigh: 0.6, anchorLow: 0.25 });
    expect(calls[0]!.events[0]).toMatchObject({ edge: 'low', newLow: 0.27 });
  });

  it('below the sample floor, inside the dead-zone, or in cooldown → no move', async () => {
    for (const stats of [
      { highEdge: { samples: 49, failures: 49 }, lowEdge: { samples: 0, failures: 0 } }, // floor
      { highEdge: { samples: 100, failures: 50 }, lowEdge: { samples: 100, failures: 30 } }, // dead-zone
    ]) {
      const { port, calls } = fakePort({
        enabled: [tenant('a', uncalibrated())],
        stats: () => stats,
      });
      const sum = await runCalibrationOccurrence(port, STRUCTURAL, CFG, RAILS, NOW, silent);
      expect(sum.moves).toBe(0);
      expect(calls).toHaveLength(0);
    }
    const { port, calls } = fakePort({
      enabled: [tenant('a', uncalibrated())],
      stats: () => ({
        highEdge: { samples: 80, failures: 70 },
        lowEdge: { samples: 0, failures: 0 },
      }),
      recentEvents: [
        {
          id: 'e1',
          trigger: 'calibrator',
          oldHigh: 0.6,
          oldLow: 0.25,
          newHigh: 0.58,
          newLow: 0.25,
          anchorHigh: 0.6,
          anchorLow: 0.25,
          windowFrom: null,
          windowTo: null,
          edge: 'high',
          edgeSamples: 50,
          edgeFailures: 40,
          reason: 'r',
          createdAt: new Date(NOW - 1 * DAY).toISOString(), // within the 3-day cooldown
        },
      ],
    });
    const sum = await runCalibrationOccurrence(port, STRUCTURAL, CFG, RAILS, NOW, silent);
    expect(sum.moves).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('the anchored drift cap stops a move at the boundary', async () => {
    // Already at anchor − maxDrift: 0.5 = 0.6 − 0.1 → a further step would breach.
    const v = uncalibrated({
      calibratedHigh: 0.5,
      calibratedLow: 0.3,
      calibratedAnchorHigh: 0.6,
      calibratedAnchorLow: 0.25,
    });
    const { port, calls } = fakePort({
      enabled: [tenant('a', v)],
      stats: () => ({
        highEdge: { samples: 90, failures: 80 },
        lowEdge: { samples: 0, failures: 0 },
      }),
    });
    const sum = await runCalibrationOccurrence(port, STRUCTURAL, CFG, RAILS, NOW, silent);
    expect(sum.moves).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('a SINGLE qualifying edge is dropped when its move alone would breach the gap', async () => {
    const structural = { high: 0.5, low: 0.3 };
    const v = uncalibrated({
      calibratedHigh: 0.45,
      calibratedLow: 0.34,
      calibratedAnchorHigh: 0.5,
      calibratedAnchorLow: 0.3,
    }); // gap 0.11; one 0.02 step → 0.09 < minGap
    const { port, calls } = fakePort({
      enabled: [tenant('a', v)],
      stats: () => ({
        highEdge: { samples: 90, failures: 80 },
        lowEdge: { samples: 0, failures: 0 },
      }),
    });
    const sum = await runCalibrationOccurrence(port, structural, CFG, RAILS, NOW, silent);
    expect(sum.moves).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('joint breach arbitrates to the stronger edge, re-checks the survivor, applies it alone', async () => {
    const structural = { high: 0.5, low: 0.3 };
    const v = uncalibrated({
      calibratedHigh: 0.47,
      calibratedLow: 0.34,
      calibratedAnchorHigh: 0.5,
      calibratedAnchorLow: 0.3,
    }); // gap 0.13: joint −0.04 → 0.09 breach; single → 0.11 fine
    const { port, calls } = fakePort({
      enabled: [tenant('a', v)],
      stats: () => ({
        highEdge: { samples: 100, failures: 80 }, // rate 0.8, strength 0.15
        lowEdge: { samples: 100, failures: 5 }, // rate 0.05, strength 0.10
      }),
    });
    const sum = await runCalibrationOccurrence(port, structural, CFG, RAILS, NOW, silent);
    expect(sum.moves).toBe(1);
    expect(calls[0]!.quad).toEqual({ high: 0.45, low: 0.34, anchorHigh: 0.5, anchorLow: 0.3 });
    expect(calls[0]!.events).toHaveLength(1);
    expect(calls[0]!.events[0]!.edge).toBe('high');
  });

  it('a MATHEMATICALLY equal deviation tie-breaks to the high edge (integer-exact)', async () => {
    const structural = { high: 0.5, low: 0.3 };
    const v = uncalibrated({
      calibratedHigh: 0.47,
      calibratedLow: 0.34,
      calibratedAnchorHigh: 0.5,
      calibratedAnchorLow: 0.3,
    }); // gap 0.13 → joint breach forces arbitration
    // high dev = 0.75 − 0.65 = 0.10; low dev = 0.15 − 0.05 = 0.10 — equal as
    // rationals, UNEQUAL as raw doubles (≈…98 vs …99). The integer-exact
    // comparison must see the tie and keep the high edge (r3-Med-4).
    const { port, calls } = fakePort({
      enabled: [tenant('a', v)],
      stats: () => ({
        highEdge: { samples: 100, failures: 75 },
        lowEdge: { samples: 100, failures: 5 },
      }),
    });
    const sum = await runCalibrationOccurrence(port, structural, CFG, RAILS, NOW, silent);
    expect(sum.moves).toBe(1);
    expect(calls[0]!.events).toHaveLength(1);
    expect(calls[0]!.events[0]!.edge).toBe('high');
  });

  it('both edges move when the gap allows — two SEQUENTIAL chained events', async () => {
    const { port, calls } = fakePort({
      enabled: [tenant('a', uncalibrated())],
      stats: () => ({
        highEdge: { samples: 60, failures: 45 },
        lowEdge: { samples: 60, failures: 2 },
      }),
    });
    const sum = await runCalibrationOccurrence(port, STRUCTURAL, CFG, RAILS, NOW, silent);
    expect(sum.moves).toBe(1);
    const events = calls[0]!.events;
    expect(events).toHaveLength(2);
    // high first, then low — before/after pairs chain linearly.
    expect(events[0]).toMatchObject({
      edge: 'high',
      oldHigh: 0.6,
      newHigh: 0.58,
      oldLow: 0.25,
      newLow: 0.25,
    });
    expect(events[1]).toMatchObject({
      edge: 'low',
      oldHigh: 0.58,
      newHigh: 0.58,
      oldLow: 0.25,
      newLow: 0.27,
    });
    expect(calls[0]!.quad).toEqual({ high: 0.58, low: 0.27, anchorHigh: 0.6, anchorLow: 0.25 });
  });

  it('degenerate instance pairs and overlapping edge zones are skipped whole', async () => {
    // Instance gap below minGap.
    let f = fakePort({ enabled: [tenant('a', uncalibrated())] });
    let sum = await runCalibrationOccurrence(
      f.port,
      { high: 0.4, low: 0.35 },
      CFG,
      RAILS,
      NOW,
      silent,
    );
    expect(sum.skips).toBe(1);
    // INCLUSIVE overlap boundary: high − w === low + w shares one score.
    f = fakePort({ enabled: [tenant('a', uncalibrated())] });
    sum = await runCalibrationOccurrence(f.port, { high: 0.4, low: 0.3 }, CFG, RAILS, NOW, silent);
    expect(sum.skips).toBe(1);
    expect(f.calls).toHaveLength(0);
  });

  it('hygiene rebases a DISABLED tenant with a stale anchor — clearing, not moving', async () => {
    const stale = uncalibrated({
      calibrationEnabled: false, // disabled — hygiene applies anyway
      calibratedHigh: 0.55,
      calibratedLow: 0.3,
      calibratedAnchorHigh: 0.7, // anchored to OLD defaults
      calibratedAnchorLow: 0.2,
      calibrationEpoch: 5,
    });
    const { port, calls } = fakePort({ stored: [tenant('a', stale)], enabled: [] });
    const sum = await runCalibrationOccurrence(port, STRUCTURAL, CFG, RAILS, NOW, silent);
    expect(sum.rebases).toBe(1);
    const call = calls[0]!;
    expect(call.quad).toBeNull();
    expect(call.expected).toMatchObject({ enabled: null, epoch: 5 });
    expect(call.events[0]).toMatchObject({
      trigger: 'rebase',
      oldHigh: 0.55,
      oldLow: 0.3,
      newHigh: 0.6,
      newLow: 0.25,
      anchorHigh: 0.6,
      anchorLow: 0.25,
    });
  });

  it('a conditional-write mismatch (concurrent user action) counts as a skip, never a move', async () => {
    const { port } = fakePort({
      enabled: [tenant('a', uncalibrated())],
      stats: () => ({
        highEdge: { samples: 60, failures: 50 },
        lowEdge: { samples: 0, failures: 0 },
      }),
      setResult: false,
    });
    const sum = await runCalibrationOccurrence(port, STRUCTURAL, CFG, RAILS, NOW, silent);
    expect(sum).toEqual({ tenants: 1, moves: 0, rebases: 0, skips: 1 });
  });

  it('one failing tenant is isolated — the sweep continues', async () => {
    const { port, calls } = fakePort({
      enabled: [tenant('bad', uncalibrated()), tenant('good', uncalibrated())],
      stats: () => ({
        highEdge: { samples: 60, failures: 50 },
        lowEdge: { samples: 0, failures: 0 },
      }),
      statsThrows: (owner) => owner === 'bad',
    });
    const sum = await runCalibrationOccurrence(port, STRUCTURAL, CFG, RAILS, NOW, silent);
    expect(sum.moves).toBe(1);
    expect(sum.skips).toBe(1);
    expect(calls.map((c) => c.owner)).toEqual(['good']);
  });
});
