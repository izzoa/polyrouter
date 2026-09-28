// add-stream-keepalive (task 4.4): the adapter publishes the relabel as
// `inflight.updated` — owner-scoped, with exactly the row shape `inflight.started` has.
import { userPrincipal } from '@polyrouter/shared/server';
import type { InflightEntry } from '../inflight/inflight-registry';
import type { DashboardEvents } from './dashboard-events';
import { InflightTransitionsAdapter } from './inflight-transitions.adapter';

const entry: InflightEntry = {
  requestId: 'req-1',
  startedAt: 1_700_000_000_000,
  decisionLayer: 'cascade',
  tierAssigned: 'heavy',
  modelLabel: 'mimo-v2.6-pro',
  providerLabel: 'XiaomiMiMo',
  protocol: 'openai',
};

describe('InflightTransitionsAdapter', () => {
  it('publishes updated to the OWNER with the same row shape as started', () => {
    const publishToOwner = jest.fn();
    const adapter = new InflightTransitionsAdapter({
      publishToOwner,
    } as unknown as DashboardEvents);
    const owner = userPrincipal('u-1');
    adapter.started(owner, entry);
    adapter.updated(owner, entry);
    expect(publishToOwner).toHaveBeenCalledTimes(2);
    const calls = publishToOwner.mock.calls as Array<[unknown, { type: string; row: unknown }]>;
    const [p1, started] = calls[0]!;
    const [p2, updated] = calls[1]!;
    expect(p1).toBe(owner);
    expect(p2).toBe(owner);
    expect(started.type).toBe('inflight.started');
    expect(updated.type).toBe('inflight.updated');
    expect(updated.row).toEqual(started.row);
    expect(updated.row).toEqual({
      id: 'req-1',
      startedAt: 1_700_000_000_000,
      decisionLayer: 'cascade',
      tierAssigned: 'heavy',
      modelLabel: 'mimo-v2.6-pro',
      providerLabel: 'XiaomiMiMo',
      protocol: 'openai',
      status: 'running',
    });
  });
});
