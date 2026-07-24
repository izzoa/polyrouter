import { Injectable } from '@nestjs/common';
import type { Principal } from '@polyrouter/shared/server';
import type { InflightEntry, InflightTransitions } from '../inflight/inflight-registry';
import { DashboardEvents } from './dashboard-events';

/**
 * Bridges the in-flight registry's transitions onto the dashboard bus
 * (phase2-add-dashboard-event-stream). Kept as a thin adapter so the registry depends
 * only on the `InflightTransitions` interface, never on the events module.
 *
 * Payloads are ASYMMETRIC and pinned: `started` carries exactly the metadata the
 * snapshot endpoint exposes for one entry; `settled` carries only `{ id }` — the
 * durable row is the authority for everything else, so settlement needs no metadata.
 */
@Injectable()
export class InflightTransitionsAdapter implements InflightTransitions {
  constructor(private readonly events: DashboardEvents) {}

  started(principal: Principal, entry: InflightEntry): void {
    this.events.publishToOwner(principal, {
      type: 'inflight.started',
      row: {
        // The same id the durable row will use, so a subscriber dedupes exactly as a
        // snapshot consumer does.
        id: entry.requestId,
        startedAt: entry.startedAt,
        decisionLayer: entry.decisionLayer,
        tierAssigned: entry.tierAssigned,
        modelLabel: entry.modelLabel,
        providerLabel: entry.providerLabel,
        protocol: entry.protocol,
        status: 'running',
      },
    });
  }

  settled(principal: Principal, requestId: string): void {
    this.events.publishToOwner(principal, { type: 'inflight.settled', id: requestId });
  }
}
