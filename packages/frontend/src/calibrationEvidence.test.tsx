/** Calibration evidence in the Auto-performance view (add-per-agent-calibration-evidence).
 *
 * This block exists to inform a maintainer decision, so the failure mode that
 * matters is not "it crashes" — it is "it reads plausibly and says something
 * false". Three of these tests target exactly that: a hardcoded floor that goes
 * stale when SQ-2 reconfigures it, a `sufficient` edge presented as though a move
 * were due when it sits in the hysteresis dead zone, and a dead-middle agent
 * rendered as a bare pair of zeros that reads as a broken calibrator.
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { Routing } from './pages/Routing';
import {
  EVIDENCE_UNLABELLED,
  edgeSummary,
  toCalibrationEvidenceVm,
} from './data/calibrationEvidence';
import { createAppStore, type AppStore } from './state/appState';
import { AppProvider } from './state/context';
import { DEFAULT_CALIBRATION_EVIDENCE, FakeApiClient, DEFAULT_AUTO_PERF } from './test/fakeClient';
import { ApiError, type CalibrationEvidence } from './data/api';

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
};

const vm = (over: Partial<CalibrationEvidence> = {}) =>
  toCalibrationEvidenceVm({ ...DEFAULT_CALIBRATION_EVIDENCE, ...over });

describe('per-edge state (pure)', () => {
  it('classifies each edge independently — one agent, two different states', () => {
    // agent-0 in the fixture: 80 current high-edge samples, zero low-edge of any
    // kind. An agent-level verdict would have to discard one of these.
    const a = vm().agents.find((x) => x.agentId === 'agent-0')!;
    expect(a.high.state).toBe('sufficient');
    expect(a.low.state).toBe('absent');
  });

  it('separates a RESET stream from an absence', () => {
    const a = vm().agents.find((x) => x.agentId === 'agent-2')!;
    // 18 rows in the window, none current — the epoch bumped. Not "no evidence".
    expect(a.high.state).toBe('reset');
    expect(a.high.windowSamples).toBe(18);
    expect(a.high.samples).toBe(0);
    expect(edgeSummary(a.high, 50)).toMatch(/threshold change/i);
  });

  it('separates ACCUMULATING from sufficient at the floor, and reads the floor from the data', () => {
    const a = vm().agents.find((x) => x.agentId === 'agent-1')!;
    expect(a.high.state).toBe('accumulating');
    expect(edgeSummary(a.high, 50)).toBe('12 of 50 needed');
    // Lower the floor and the SAME counts become sufficient. A hardcoded 50
    // would fail this — which is the point, since SQ-2 changes the floor.
    const lower = vm({ actingFloor: 10 }).agents.find((x) => x.agentId === 'agent-1')!;
    expect(lower.high.state).toBe('sufficient');
    expect(edgeSummary(lower.high, 10)).not.toContain('of 10 needed');
  });

  it('flags a sufficient edge inside the dead zone rather than implying a move', () => {
    // agent-0: 40/80 = 50% against a 0.65 high bound — it will never move.
    const a = vm().agents.find((x) => x.agentId === 'agent-0')!;
    expect(a.high.state).toBe('sufficient');
    expect(a.high.rate).toBeCloseTo(0.5, 6);
    expect(a.high.inDeadZone).toBe(true);
    expect(edgeSummary(a.high, 50)).toMatch(/no move/i);

    // Raise the failure count past the bound and the caveat goes away.
    const hot = vm({
      agents: DEFAULT_CALIBRATION_EVIDENCE.agents.map((x) =>
        x.agentId === 'agent-0'
          ? { ...x, highEdge: { ...x.highEdge, currentEpoch: { samples: 80, failures: 60 } } }
          : x,
      ),
    }).agents.find((x) => x.agentId === 'agent-0')!;
    expect(hot.high.inDeadZone).toBe(false);
    expect(edgeSummary(hot.high, 50)).not.toMatch(/no move/i);
  });

  it('applies the LOW edge bound in the opposite direction', () => {
    // agent-1 low: 1/12 ≈ 8.3%, at or BELOW the 0.15 bound — it has reached it.
    const a = vm().agents.find((x) => x.agentId === 'agent-1')!;
    expect(a.low.inDeadZone).toBe(false);
    // A high failure rate on the LOW edge is the dead zone for that edge.
    const noisy = vm({
      agents: DEFAULT_CALIBRATION_EVIDENCE.agents.map((x) =>
        x.agentId === 'agent-1'
          ? { ...x, lowEdge: { ...x.lowEdge, currentEpoch: { samples: 12, failures: 9 } } }
          : x,
      ),
    }).agents.find((x) => x.agentId === 'agent-1')!;
    expect(noisy.low.inDeadZone).toBe(true);
  });

  it('never yields NaN, and never a raw id as a label', () => {
    const a = vm().agents.find((x) => x.agentId === 'agent-dead-middle')!;
    expect(a.high.rate).toBeNull(); // 0 samples — null, not 0/0
    expect(a.label).toBe(EVIDENCE_UNLABELLED);
    expect(a.label).not.toBe(a.agentId);
    expect(a.deadMiddle).toBe(true);
  });

  it('does not flag dead-middle when there is simply no evidence at all', () => {
    const none = vm({
      agents: [
        {
          agentId: 'quiet',
          label: 'quiet',
          highEdge: {
            currentEpoch: { samples: 0, failures: 0 },
            window: { samples: 0, failures: 0 },
          },
          lowEdge: {
            currentEpoch: { samples: 0, failures: 0 },
            window: { samples: 0, failures: 0 },
          },
          middleRows: { currentEpoch: 0, window: 0 },
        },
      ],
    }).agents[0]!;
    expect(none.deadMiddle).toBe(false);
    expect(edgeSummary(none.high, 50)).toMatch(/no decided rows/i);
  });
});

describe('the section renders honestly', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  const mount = async (client: FakeApiClient): Promise<HTMLElement> => {
    const store: AppStore = createAppStore(client);
    const host = document.createElement('div');
    document.body.append(host);
    dispose = render(
      () => (
        <AppProvider store={store}>
          <Routing />
        </AppProvider>
      ),
      host,
    );
    // The Auto-performance card lives in the TUNING section, which is offered
    // only while the structural capability is available and the user is standing
    // on it. Driven through state rather than clicks — this suite is about what
    // the section SAYS, and the rail's own behaviour is covered elsewhere.
    await store.loadRouting();
    await flush();
    store.setState('autoLayers', 'structuralAvailable', true);
    store.setRoutingSection('tuning');
    await store.loadAutoPerf();
    await flush();
    return host;
  };

  const section = (host: HTMLElement): HTMLElement | null =>
    host.querySelector('[data-testid="calibration-evidence"]');

  it('states the window and the rails from the response, never as literals', async () => {
    const host = await mount(new FakeApiClient());
    const geom = section(host)?.querySelector('[data-testid="calibration-geometry"]');
    expect(geom, 'no geometry line rendered').not.toBeNull();
    const text = geom?.textContent ?? '';
    // The window is the CALIBRATION window, and says so — the page's range
    // selector controls a different measurement entirely.
    expect(text).toContain('14 days');
    expect(text).toMatch(/not the range/i);
    expect(text).toContain('50'); // the acting floor, from the response
    expect(text).toContain('0.6');
    expect(text).toContain('0.25');
    expect(text).toContain('0.05');
  });

  it('renders a reconfigured floor, proving nothing is hardcoded', async () => {
    const client = new FakeApiClient({
      autoPerf: {
        ...DEFAULT_AUTO_PERF,
        calibrationEvidence: { ...DEFAULT_CALIBRATION_EVIDENCE, actingFloor: 15 },
      },
    });
    const host = await mount(client);
    const text =
      section(host)?.querySelector('[data-testid="calibration-geometry"]')?.textContent ?? '';
    expect(text).toContain('15');
    expect(text).not.toMatch(/\b50 samples needed\b/);
  });

  it('renders all four edge states distinguishably', async () => {
    const host = await mount(new FakeApiClient());
    const s = section(host)!;
    expect(s.querySelector('[data-testid="cal-edge-high-sufficient"]')).not.toBeNull();
    expect(s.querySelector('[data-testid="cal-edge-high-reset"]')).not.toBeNull();
    expect(s.querySelector('[data-testid="cal-edge-high-accumulating"]')).not.toBeNull();
    expect(s.querySelector('[data-testid="cal-edge-low-absent"]')).not.toBeNull();
  });

  it('explains a dead-middle agent instead of showing a bare pair of zeros', async () => {
    const host = await mount(new FakeApiClient());
    const note = section(host)?.querySelector('[data-testid="cal-dead-middle"]');
    expect(note, 'the dead-middle case rendered as two silent zeros').not.toBeNull();
    expect(note?.textContent ?? '').toMatch(/between the edge zones/i);
    expect(note?.textContent ?? '').toContain('60');
  });

  it('never renders a raw agent id', async () => {
    const host = await mount(new FakeApiClient());
    expect(section(host)?.innerHTML ?? '').not.toContain('agent-dead-middle');
    expect(section(host)?.textContent ?? '').toContain(EVIDENCE_UNLABELLED);
  });

  it('renders no section, and no figures, when the aggregation failed', async () => {
    // The Routing page fetches auto-perf itself (it is cross-consumed by the Band
    // and Workload target cards), so "not yet loaded" is not a state a user sits
    // in. The state that matters is a FAILED load: the block must be absent
    // rather than rendering zeros that would read as measured counts.
    const client = new FakeApiClient({
      analyticsFailure: new ApiError(500, 'Server Error', 'boom'),
    });
    const store = createAppStore(client);
    const host = document.createElement('div');
    document.body.append(host);
    dispose = render(
      () => (
        <AppProvider store={store}>
          <Routing />
        </AppProvider>
      ),
      host,
    );
    await store.loadRouting();
    await flush();
    store.setState('autoLayers', 'structuralAvailable', true);
    store.setRoutingSection('tuning');
    await store.loadAutoPerf();
    await flush();

    expect(store.state.autoPerf.data).toBeNull();
    expect(section(host)).toBeNull();
  });
});

describe('honesty fixes (fix-calibration-evidence-honesty)', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  const mountWith = async (over: Partial<CalibrationEvidence>): Promise<HTMLElement> => {
    const client = new FakeApiClient({
      autoPerf: {
        ...DEFAULT_AUTO_PERF,
        calibrationEvidence: { ...DEFAULT_CALIBRATION_EVIDENCE, ...over },
      },
    });
    const store = createAppStore(client);
    const host = document.createElement('div');
    document.body.append(host);
    dispose = render(
      () => (
        <AppProvider store={store}>
          <Routing />
        </AppProvider>
      ),
      host,
    );
    await store.loadRouting();
    await flush();
    store.setState('autoLayers', 'structuralAvailable', true);
    store.setRoutingSection('tuning');
    await store.loadAutoPerf();
    await flush();
    return host;
  };

  it('does not call it a RESET when no threshold event ever happened', () => {
    // Rows in the window, none current, and epochStartedAt null: the rows
    // predate epoch tracking. Saying "none since the last threshold change"
    // asserts an event that never occurred.
    const v = toCalibrationEvidenceVm({ ...DEFAULT_CALIBRATION_EVIDENCE, epochStartedAt: null });
    const a = v.agents.find((x) => x.agentId === 'agent-2')!;
    expect(a.high.state).toBe('unaligned');
    expect(edgeSummary(a.high, 50)).toMatch(/predating epoch tracking/i);
    expect(edgeSummary(a.high, 50)).not.toMatch(/threshold change/i);

    // With a real event the SAME shape is a genuine reset.
    const withEvent = toCalibrationEvidenceVm(DEFAULT_CALIBRATION_EVIDENCE);
    expect(withEvent.agents.find((x) => x.agentId === 'agent-2')!.high.state).toBe('reset');
  });

  it('renders the tenant TOTAL as the figure the calibrator evaluates', async () => {
    // Three agents at 30 each: every per-agent row reads "below the floor",
    // while the tenant total of 90 is what actually moves the threshold.
    const thirds = ['a', 'b', 'c'].map((id) => ({
      agentId: id,
      label: id,
      highEdge: {
        currentEpoch: { samples: 30, failures: 25 },
        window: { samples: 30, failures: 25 },
      },
      lowEdge: { currentEpoch: { samples: 0, failures: 0 }, window: { samples: 0, failures: 0 } },
      middleRows: { currentEpoch: 0, window: 0 },
    }));
    const host = await mountWith({
      agents: thirds,
      total: {
        agentId: null,
        label: null,
        highEdge: {
          currentEpoch: { samples: 90, failures: 75 },
          window: { samples: 90, failures: 75 },
        },
        lowEdge: { currentEpoch: { samples: 0, failures: 0 }, window: { samples: 0, failures: 0 } },
        middleRows: { currentEpoch: 0, window: 0 },
      },
    });
    const total = host.querySelector('[data-testid="cal-total"]');
    expect(total, 'the deciding figure is not on screen').not.toBeNull();
    expect(total?.textContent ?? '').toContain('90');
    expect(total?.textContent ?? '').toMatch(/calibrator evaluates/i);
  });

  it('discloses a disabled mechanism and a halted one', async () => {
    const off = await mountWith({ enabled: false });
    expect(off.querySelector('[data-testid="cal-disabled"]')).not.toBeNull();
    expect(off.querySelector('[data-testid="cal-contracted"]')).toBeNull();
    dispose?.();
    dispose = undefined;

    const halted = await mountWith({ enabled: true, contracted: true });
    expect(halted.querySelector('[data-testid="cal-disabled"]')).toBeNull();
    const note = halted.querySelector('[data-testid="cal-contracted"]');
    expect(note, 'a halted calibrator was not disclosed').not.toBeNull();
    expect(note?.textContent ?? '').toMatch(/halted/i);
  });

  it('discloses truncation, and the total is not the visible subset', async () => {
    const host = await mountWith({ truncated: true });
    const note = host.querySelector('[data-testid="cal-truncated"]');
    expect(note).not.toBeNull();
    expect(note?.textContent ?? '').toMatch(/every agent/i);
  });

  it('never prints a rate AS its bound when the bound was not met', () => {
    // 0.646 is below the 0.65 high bound, so the edge IS in the dead zone. An
    // integer percent would print "65%" beside "inside the dead zone", which
    // reads as a broken check rather than a rate below the bound.
    const v = toCalibrationEvidenceVm({
      ...DEFAULT_CALIBRATION_EVIDENCE,
      agents: [
        {
          agentId: 'edge',
          label: 'edge',
          highEdge: {
            currentEpoch: { samples: 1000, failures: 646 },
            window: { samples: 1000, failures: 646 },
          },
          lowEdge: {
            currentEpoch: { samples: 0, failures: 0 },
            window: { samples: 0, failures: 0 },
          },
          middleRows: { currentEpoch: 0, window: 0 },
        },
      ],
    });
    const e = v.agents[0]!.high;
    expect(e.inDeadZone).toBe(true);
    const line = edgeSummary(e, 50);
    expect(line).toMatch(/no move/i);
    expect(line).toContain('64.6%');
    expect(line).not.toContain('65%');
  });
});
