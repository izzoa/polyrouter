import { userPrincipal } from '@polyrouter/shared/server';
import { AnalyticsNudgeAdapter } from './analytics-nudge.adapter';
import { DashboardEvents, ownerKeyOf, type DashboardSubscriber } from './dashboard-events';
import type { EventsConfig } from './events.config';

/**
 * phase2-add-dashboard-event-stream: nudges are COALESCED per owner so a burst of
 * settled requests can never amplify into a query storm, and they are emitted from the
 * writer's successful flush (post-insert) so a pushed refetch can actually observe the
 * row it was told about.
 */

const CFG = { nudgeCoalesceMs: 20 } as EventsConfig;

function sink(): DashboardSubscriber & { got: string[] } {
  const got: string[] = [];
  return { got, enqueue: (e) => got.push(e.type), close: () => undefined };
}

const A = userPrincipal('owner-A');
const B = userPrincipal('owner-B');
const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('AnalyticsNudgeAdapter', () => {
  it('coalesces a BURST of settles into ONE nudge per owner per window', async () => {
    const bus = new DashboardEvents();
    const a = sink();
    bus.subscribe(ownerKeyOf(A), a);
    const nudge = new AnalyticsNudgeAdapter(bus, CFG);

    // 1,000 rows settling in a tight burst — the exact self-DoS shape.
    for (let i = 0; i < 1_000; i += 1) nudge.invalidated(A);
    expect(a.got).toEqual([]); // trailing edge: nothing yet
    await tick(40);
    expect(a.got).toEqual(['analytics.invalidated']); // exactly one

    nudge.onApplicationShutdown();
  });

  it('keeps owners independent', async () => {
    const bus = new DashboardEvents();
    const a = sink();
    const b = sink();
    bus.subscribe(ownerKeyOf(A), a);
    bus.subscribe(ownerKeyOf(B), b);
    const nudge = new AnalyticsNudgeAdapter(bus, CFG);

    nudge.invalidated(A);
    await tick(40);
    expect(a.got).toEqual(['analytics.invalidated']);
    expect(b.got).toEqual([]); // B's aggregates are not stale

    nudge.onApplicationShutdown();
  });

  it('opens a NEW window after the previous one fired', async () => {
    const bus = new DashboardEvents();
    const a = sink();
    bus.subscribe(ownerKeyOf(A), a);
    const nudge = new AnalyticsNudgeAdapter(bus, CFG);

    nudge.invalidated(A);
    await tick(40);
    nudge.invalidated(A);
    await tick(40);
    expect(a.got).toEqual(['analytics.invalidated', 'analytics.invalidated']);

    nudge.onApplicationShutdown();
  });

  it('drops pending nudges on shutdown rather than firing into a closing process', async () => {
    const bus = new DashboardEvents();
    const a = sink();
    bus.subscribe(ownerKeyOf(A), a);
    const nudge = new AnalyticsNudgeAdapter(bus, CFG);
    nudge.invalidated(A);
    nudge.onApplicationShutdown();
    await tick(40);
    expect(a.got).toEqual([]);
  });

  it('is emitted POST-INSERT: a nudge-driven read observes the settled row', async () => {
    // The ordering property that makes push not-staler-than-polling. The recorder only
    // ENQUEUES; the writer batches on ~1s. If the nudge fired at enqueue time the
    // pushed refetch would read request_log BEFORE the row landed and — under the
    // shared floor — would consume the next scheduled poll, deferring the real update
    // a full interval. So the adapter is only ever called from a SUCCESSFUL flush.
    const bus = new DashboardEvents();
    const rowsVisible: string[] = []; // stands in for request_log
    const a: DashboardSubscriber = {
      // A nudge-driven aggregate read, at the moment the nudge is delivered.
      enqueue: () => void observed.push([...rowsVisible]),
      close: () => undefined,
    };
    const observed: string[][] = [];
    bus.subscribe(ownerKeyOf(A), a);
    const nudge = new AnalyticsNudgeAdapter(bus, CFG);

    // Simulate the writer: enqueue (row NOT yet durable) … then flush … then nudge.
    const enqueueOnly = (id: string): void => void id; // the recorder's only action
    enqueueOnly('req-1');
    expect(rowsVisible).toEqual([]); // nothing durable yet — nudging here would be wrong
    rowsVisible.push('req-1'); // insertMany succeeded
    nudge.invalidated(A); // …and ONLY now is the nudge published
    await tick(40);

    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual(['req-1']); // the read SEES the settled request's row
    nudge.onApplicationShutdown();
  });
});
