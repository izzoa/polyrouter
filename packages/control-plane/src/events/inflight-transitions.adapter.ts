import { Injectable } from '@nestjs/common';
import type { Principal } from '@polyrouter/shared/server';
import type { InflightEntry, InflightTransitions } from '../inflight/inflight-registry';
import { DashboardEvents } from './dashboard-events';

/**
 * Bridges the in-flight registry's transitions onto the dashboard bus
 * (phase2-add-dashboard-event-stream). Kept as a thin adapter so the registry depends
 * only on the `InflightTransitions` interface, never on the events module.
 *
 * Payloads are ASYMMETRIC and pinned: `started` (and `updated`, its in-place relabel —
 * add-stream-keepalive) carries exactly the metadata the snapshot endpoint exposes for
 * one entry; `settled` carries only `{ id }` — the durable row is the authority for
 * everything else, so settlement needs no metadata.
 */
@Injectable()
export class InflightTransitionsAdapter implements InflightTransitions {
  constructor(private readonly events: DashboardEvents) {}

  started(principal: Principal, entry: InflightEntry): void {
    this.events.publishToOwner(principal, { type: 'inflight.started', row: rowOf(entry) });
  }

  /** add-stream-keepalive: a cascade escalation relabelled the entry. Same row shape
   * and id as `started`, so a subscriber updates the displayed row in place. */
  updated(principal: Principal, entry: InflightEntry): void {
    this.events.publishToOwner(principal, { type: 'inflight.updated', row: rowOf(entry) });
  }

  settled(principal: Principal, requestId: string): void {
    this.events.publishToOwner(principal, { type: 'inflight.settled', id: requestId });
  }
}

/** The one row shape `started` and `updated` share — the same id the durable row will
 * use, so a subscriber dedupes exactly as a snapshot consumer does. */
function rowOf(entry: InflightEntry): {
  id: string;
  startedAt: number;
  decisionLayer: string;
  tierAssigned: string | null;
  modelLabel: string | null;
  providerLabel: string | null;
  protocol: string;
  status: 'running';
} {
  return {
    id: entry.requestId,
    startedAt: entry.startedAt,
    decisionLayer: entry.decisionLayer,
    tierAssigned: entry.tierAssigned,
    modelLabel: entry.modelLabel,
    providerLabel: entry.providerLabel,
    protocol: entry.protocol,
    status: 'running',
  };
}
