import type { Response } from 'express';
import type { DashboardEvent, DashboardSubscriber } from './dashboard-events';

/**
 * One dashboard SSE connection: stage (iii) of publication — the asynchronous socket
 * writer (phase2-add-dashboard-event-stream).
 *
 * `enqueue` (stage ii) is synchronous, bounded and never throws; the drain loop does
 * the actual `write`/`await drain`, reusing the discipline already proven for
 * inference streaming (`proxy/proxy-http.ts:61-63` abort/close wiring and `:77-106`
 * headers, `flushHeaders()`, write/drain, destroy-vs-end).
 *
 * On overflow the pending backlog is DROPPED and collapsed to a single `resync`
 * directive, so a slow consumer degrades to a coarser-but-correct view and server
 * memory per connection has a hard ceiling (invariant 12) — never unbounded buffering.
 */
export class SseConnection implements DashboardSubscriber {
  private queue: DashboardEvent[] = [];
  private draining = false;
  private closed = false;
  /** Set when the queue overflowed: the client must re-establish from a snapshot. */
  private overflowed = false;

  constructor(
    private readonly res: Response,
    private readonly queueLimit: number,
    private readonly onClosed: () => void,
  ) {}

  /** Stage (ii): synchronous, bounded, non-throwing. */
  enqueue(event: DashboardEvent): void {
    if (this.closed) return;
    if (this.overflowed) {
      // Already collapsed to a resync — further deltas are meaningless until the
      // client re-snapshots, so drop them instead of growing the queue.
      if (event.type !== 'snapshot') return;
      this.overflowed = false;
    }
    if (this.queue.length >= this.queueLimit) {
      this.queue = [{ type: 'resync' }];
      this.overflowed = true;
    } else {
      this.queue.push(event);
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining || this.closed) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const next = this.queue.shift();
        if (next === undefined) break;
        if (!this.write(next)) await this.awaitDrain();
      }
    } finally {
      this.draining = false;
    }
  }

  /** Returns false when the socket asked us to wait (backpressure). */
  private write(event: DashboardEvent): boolean {
    if (this.closed || this.res.writableEnded) return true;
    const { type, ...data } = event;
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    try {
      return this.res.write(frame);
    } catch {
      this.close('write_failed');
      return true;
    }
  }

  private awaitDrain(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        this.res.off('drain', done);
        this.res.off('close', done);
        this.res.off('error', done);
        resolve();
      };
      this.res.once('drain', done);
      this.res.once('close', done);
      this.res.once('error', done);
    });
  }

  /** Drop everything queued (never flush it) and end the response. Idempotent. */
  close(_reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.queue = []; // the revocation/shutdown latch: queued frames are DROPPED
    try {
      if (!this.res.writableEnded) this.res.end();
    } catch {
      // best-effort
    }
    this.onClosed();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Test/introspection seam: pending frames not yet written. */
  get pending(): number {
    return this.queue.length;
  }
}
