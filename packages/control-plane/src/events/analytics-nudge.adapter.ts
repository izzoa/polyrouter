import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { Principal } from '@polyrouter/shared/server';
import { DashboardEvents, ownerKeyOf } from './dashboard-events';
import { EVENTS_CONFIG, type EventsConfig } from './events.config';
import type { AnalyticsInvalidationSink } from '../recording/log-writer';

/**
 * Coalesced `analytics.invalidated` nudges (phase2-add-dashboard-event-stream).
 *
 * A naive nudge is a self-DoS: 10k settles would become 10k nudges and, per connected
 * tab, 10k × 4 aggregate queries — strictly WORSE than the 15s poll it supplements.
 * So the server coalesces per owner over a bounded window (trailing edge), and the
 * client additionally floors refetches on a budget SHARED with its analytics poll.
 *
 * Nudges convey only "aggregates are stale" — never data.
 */
@Injectable()
export class AnalyticsNudgeAdapter implements AnalyticsInvalidationSink, OnApplicationShutdown {
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly events: DashboardEvents,
    @Inject(EVENTS_CONFIG) private readonly cfg: EventsConfig,
  ) {}

  /** Called from the log writer's SUCCESSFUL flush — post-insert, never at enqueue.
   * Nudging at enqueue time would race the ≤1s batch insert: the pushed refetch would
   * read `request_log` before the row landed and, under the shared floor, consume the
   * next scheduled poll — deferring the real update a full interval and making push
   * STALER than polling. */
  invalidated(principal: Principal): void {
    const key = ownerKeyOf(principal);
    if (this.pending.has(key)) return; // already coalescing this window
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.events.publish(key, { type: 'analytics.invalidated' });
    }, this.cfg.nudgeCoalesceMs);
    timer.unref?.();
    this.pending.set(key, timer);
  }

  onApplicationShutdown(): void {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }
}
