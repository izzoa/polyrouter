import { userPrincipal } from '@polyrouter/shared/server';
import { DashboardEvents, ownerKeyOf, type DashboardSubscriber } from './dashboard-events';

/** phase2-add-dashboard-event-stream: isolation lives in the FANOUT, so no event type
 * can bypass it (invariant 5). */

function recorder(): DashboardSubscriber & { got: string[]; closed: string[] } {
  const got: string[] = [];
  const closed: string[] = [];
  return {
    got,
    closed,
    enqueue: (e) => got.push(e.type),
    close: (r) => closed.push(r),
  };
}

const A = userPrincipal('user-A');
const B = userPrincipal('user-B');

describe('DashboardEvents', () => {
  it('delivers only an owner\'s own events — two owners never cross', () => {
    const bus = new DashboardEvents();
    const a = recorder();
    const b = recorder();
    bus.subscribe(ownerKeyOf(A), a);
    bus.subscribe(ownerKeyOf(B), b);

    bus.publishToOwner(A, { type: 'inflight.settled', id: 'r1' });
    bus.publishToOwner(B, { type: 'analytics.invalidated' });

    expect(a.got).toEqual(['inflight.settled']);
    expect(b.got).toEqual(['analytics.invalidated']);
  });

  it('is a no-op with no subscriber, and stops after unsubscribe', () => {
    const bus = new DashboardEvents();
    expect(() => bus.publishToOwner(A, { type: 'heartbeat' })).not.toThrow();
    const a = recorder();
    const off = bus.subscribe(ownerKeyOf(A), a);
    off();
    bus.publishToOwner(A, { type: 'heartbeat' });
    expect(a.got).toEqual([]); // no publish-after-close, no leak
    expect(bus.countFor(ownerKeyOf(A))).toBe(0);
  });

  it('never lets a broken subscriber escape to the publisher', () => {
    const bus = new DashboardEvents();
    bus.subscribe(ownerKeyOf(A), {
      enqueue: () => {
        throw new Error('consumer exploded');
      },
      close: () => undefined,
    });
    // The request that published must be unaffected — same terms as the registry's
    // own Redis writes.
    expect(() => bus.publishToOwner(A, { type: 'heartbeat' })).not.toThrow();
  });

  it('LATCHES on revoke: closes, and nothing more is enqueued for that owner', () => {
    const bus = new DashboardEvents();
    const a = recorder();
    bus.subscribe(ownerKeyOf(A), a);
    bus.revoke(ownerKeyOf(A), 'authorization_revoked');
    expect(a.closed).toEqual(['authorization_revoked']);

    bus.publishToOwner(A, { type: 'inflight.settled', id: 'r1' });
    expect(a.got).toEqual([]); // nothing after revocation is observed
  });

  it('closeAll ends every stream at once (shutdown never waits)', () => {
    const bus = new DashboardEvents();
    const a = recorder();
    const b = recorder();
    bus.subscribe(ownerKeyOf(A), a);
    bus.subscribe(ownerKeyOf(B), b);
    expect(bus.closeAll('server_shutdown')).toBe(2);
    expect(a.closed).toEqual(['server_shutdown']);
    expect(b.closed).toEqual(['server_shutdown']);
  });

  it('re-subscribing clears a stale latch (the client just re-authorized)', () => {
    const bus = new DashboardEvents();
    bus.revoke(ownerKeyOf(A), 'authorization_revoked');
    const a = recorder();
    bus.subscribe(ownerKeyOf(A), a);
    bus.publishToOwner(A, { type: 'heartbeat' });
    expect(a.got).toEqual(['heartbeat']);
  });
});
