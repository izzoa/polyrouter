import { Injectable, Logger } from '@nestjs/common';
import type { InflightSnapshot, Principal } from '@polyrouter/shared/server';

/**
 * The owner-scoped in-process dashboard event bus (phase2-add-dashboard-event-stream).
 *
 * Isolation lives HERE — in the fanout itself, not per event type — so no event type
 * can bypass it (invariant 5). The baseline is documented single-replica ("One app
 * replica only … do not `--scale app`"), so an in-process emitter is correct and
 * sufficient; Redis pub/sub is the named graduation, deliberately not built here.
 *
 * Publication is THREE stages, because "ordered delivery" and "never blocks the
 * request" are only jointly satisfiable when they apply to different stages — a
 * synchronous step that hangs would block the event loop, so fire-and-forget could
 * not isolate it:
 *
 *   (i)   request path   bounded O(1) scheduling; never awaits dispatch
 *   (ii)  dispatcher     synchronous, serialized, bounded enqueue into capped
 *                        per-connection queues; never invokes/awaits a writer
 *   (iii) socket writer  async write/drain, contained by the queue bound + `resync`
 *
 * Ordering is guaranteed at (ii), where it is cheap and cannot block. The
 * slow-consumer fault lives at (iii), where backpressure already handles it.
 */

/** One live in-flight row as the stream carries it — exactly the snapshot's
 * per-entry metadata. METADATA ONLY (invariant 8). */
export type StreamInflightRow = InflightSnapshot['items'][number];

/** Wire events. `started` carries the row; `settled` carries ONLY the id (the durable
 * row is the authority for everything else) — the asymmetry is deliberate. */
export type DashboardEvent =
  | {
      readonly type: 'snapshot';
      readonly items: readonly StreamInflightRow[];
      readonly available: boolean;
      readonly truncated: boolean;
      readonly heartbeatIntervalMs: number;
      readonly reconciliationIntervalMs: number;
    }
  | { readonly type: 'inflight.started'; readonly row: StreamInflightRow }
  | { readonly type: 'inflight.settled'; readonly id: string }
  | { readonly type: 'analytics.invalidated' }
  | { readonly type: 'heartbeat' }
  | { readonly type: 'resync' };

/** A connected consumer. `enqueue` is stage (ii): synchronous, bounded, and it MUST
 * NOT throw or block — overflow is handled by collapsing to a single `resync`. */
export interface DashboardSubscriber {
  enqueue(event: DashboardEvent): void;
  /** Close from the server side (revocation, shutdown, cap). Idempotent. */
  close(reason: string): void;
}

/** Stable owner key. Mirrors the registry's owner tagging so a stream and the
 * snapshot it reconciles against always agree on whose data is whose. */
export function ownerKeyOf(principal: Principal): string {
  return principal.kind === 'user' ? `u:${principal.userId}` : `o:${principal.orgId}`;
}

@Injectable()
export class DashboardEvents {
  private readonly logger = new Logger(DashboardEvents.name);
  private readonly subs = new Map<string, Set<DashboardSubscriber>>();
  /** Revocation latch: once set, nothing more is enqueued for that owner. */
  private readonly revoked = new Set<string>();

  countFor(key: string): number {
    return this.subs.get(key)?.size ?? 0;
  }

  subscribe(key: string, sub: DashboardSubscriber): () => void {
    let set = this.subs.get(key);
    if (set === undefined) {
      set = new Set();
      this.subs.set(key, set);
    }
    set.add(sub);
    // A fresh subscription clears any stale latch for the owner (they just
    // re-authorized at connect).
    this.revoked.delete(key);
    return () => {
      const cur = this.subs.get(key);
      if (cur === undefined) return;
      cur.delete(sub);
      if (cur.size === 0) this.subs.delete(key);
    };
  }

  /**
   * Stages (i)+(ii): O(1) scheduling plus a synchronous, serialized, bounded enqueue.
   * NEVER throws and never awaits a writer — a failure is logged (secret-free) and
   * dropped, exactly like the registry's own Redis writes.
   */
  publish(key: string, event: DashboardEvent): void {
    if (this.revoked.has(key)) return; // latched: nothing after revocation is observed
    const set = this.subs.get(key);
    if (set === undefined || set.size === 0) return; // no subscriber is a no-op
    for (const sub of set) {
      try {
        sub.enqueue(event);
      } catch (err) {
        // A broken consumer must never affect the request that published.
        this.logger.warn(`dashboard event dropped: ${String((err as Error).message)}`);
      }
    }
  }

  publishToOwner(principal: Principal, event: DashboardEvent): void {
    this.publish(ownerKeyOf(principal), event);
  }

  /**
   * The revocation latch: from now on nothing is enqueued for this owner, every
   * queued frame is dropped rather than flushed, and the connections are closed.
   * Bytes already handed to the socket cannot be recalled — hence the guarantee is
   * "nothing enqueued/written after revocation is OBSERVED", not an absolute instant.
   */
  revoke(key: string, reason: string): void {
    this.revoked.add(key);
    const set = this.subs.get(key);
    if (set === undefined) return;
    for (const sub of [...set]) {
      try {
        sub.close(reason);
      } catch {
        // closing is best-effort
      }
    }
    this.subs.delete(key);
  }

  /** Shutdown: close every stream at once (never wait — see DashboardStreamRegistry). */
  closeAll(reason: string): number {
    let n = 0;
    for (const [, set] of this.subs) {
      for (const sub of [...set]) {
        n += 1;
        try {
          sub.close(reason);
        } catch {
          // best-effort
        }
      }
    }
    this.subs.clear();
    return n;
  }
}
