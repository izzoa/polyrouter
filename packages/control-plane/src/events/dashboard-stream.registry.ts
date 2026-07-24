import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { DashboardEvents } from './dashboard-events';

/**
 * Shutdown handling for dashboard streams (phase2-add-dashboard-event-stream).
 *
 * Deliberately SEPARATE from the inference `StreamDrainRegistry`, and with the
 * opposite policy. That registry *waits* for in-flight inference streams up to
 * `streamDrainDeadlineMs` (15s) because they are finite work worth finishing; a
 * dashboard stream is an unbounded subscription, so registering it there would add
 * the full drain deadline to EVERY restart. Here the correct behaviour is: close at
 * once and let the client reconnect to the next process.
 *
 * ORDERING IS ENFORCED, NOT ASSUMED. Nest does not guarantee hook order *across*
 * providers, so this uses `onModuleDestroy` — which the framework runs in a strictly
 * earlier phase than `beforeApplicationShutdown` (where the inference drain waits).
 * That makes "dashboard streams close first" a property of the lifecycle contract
 * rather than an accident of registration order that a refactor could silently break.
 *
 * Closing dashboard streams first also frees sockets, which can only help the
 * inference drain finish — it never aborts or delays it.
 */
@Injectable()
export class DashboardStreamRegistry implements OnModuleDestroy {
  private readonly logger = new Logger(DashboardStreamRegistry.name);
  private draining = false;

  constructor(private readonly events: DashboardEvents) {}

  /**
   * True once shutdown has begun. The HTTP server keeps listening for the whole
   * inference-drain window, so without this check a reconnecting `EventSource` would
   * open a FRESH unbounded stream on the dying process and pin `httpServer.close()` —
   * reintroducing exactly the restart delay this class exists to prevent.
   */
  isDraining(): boolean {
    return this.draining;
  }

  /** Idempotent. */
  onModuleDestroy(): void {
    if (this.draining) return;
    this.draining = true;
    const closed = this.events.closeAll('server_shutdown');
    if (closed > 0) this.logger.log(`closed ${String(closed)} dashboard stream(s) for shutdown`);
  }
}
