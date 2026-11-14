import { describe, expect, it } from 'vitest';
import {
  ROUTE_CAPABILITIES,
  ROUTE_LEG_ENDS,
  ROUTE_LEG_LIST_MAX,
  ROUTE_LEG_NAMES,
  ROUTE_LEGS_MAX,
  type RouteLeg,
} from '../src/index';

// record-route-legs (design D2/D3): the closed enums the writer allowlists and the
// dashboard switches on. Widening one is a contract change, so it fails here first.
describe('the route record contract', () => {
  it('pins the leg names, the ends, the capabilities and the bounds', () => {
    expect(ROUTE_LEG_NAMES).toEqual(['primary', 'cheap', 'escalation']);
    expect(ROUTE_LEG_ENDS).toEqual([
      'served',
      'gate_failed',
      'replay_failed',
      'exhausted',
      'stopped',
      'deadline',
      'cancelled',
    ]);
    expect(ROUTE_CAPABILITIES).toEqual(['tools', 'vision']);
    expect([ROUTE_LEGS_MAX, ROUTE_LEG_LIST_MAX]).toEqual([2, 32]);
  });

  // `request-logging.e2e` asserts that a plain explicit `success` row's JSON contains no
  // `hi`. The column rides every row, so no key or enum value may contain it.
  it('no key or enum value contains `hi`, which a whole-row e2e guard scans for', () => {
    const full: Required<RouteLeg> = {
      leg: 'escalation',
      end: 'stopped',
      endedMs: 1,
      servedIndex: 0,
      stopped: { index: 1, model: 'm', sent: true, kind: 'k', status: 451 },
      ask: 2,
      deferred: [
        { index: 2, model: 'm', reason: 'output_cap', cap: 1 },
        { index: 3, model: 'm', reason: 'capability', capabilities: ['tools'] },
      ],
      clamps: [{ index: 0, model: 'm', to: 1 }],
    };
    const keys = JSON.stringify(full).match(/"[A-Za-z_]+":/g) ?? [];
    const words = [
      ...keys,
      ...ROUTE_LEG_NAMES,
      ...ROUTE_LEG_ENDS,
      ...ROUTE_CAPABILITIES,
      'output_cap',
      'capability',
    ];
    for (const w of words) expect(w.toLowerCase(), w).not.toContain('hi');
  });
});
