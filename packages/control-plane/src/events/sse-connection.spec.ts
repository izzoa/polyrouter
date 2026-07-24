import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { SseConnection } from './sse-connection';

/** phase2-add-dashboard-event-stream: stage (iii). A slow consumer degrades to a
 * coarser-but-correct view via `resync`, never to unbounded server memory
 * (invariant 12). */

class FakeRes extends EventEmitter {
  writableEnded = false;
  frames: string[] = [];
  /** When false, `write` reports backpressure (the caller must await 'drain'). */
  accept = true;
  write(chunk: string): boolean {
    this.frames.push(chunk);
    return this.accept;
  }
  end(): void {
    this.writableEnded = true;
  }
}

const asRes = (r: FakeRes): Response => r as unknown as Response;
const types = (r: FakeRes): string[] =>
  r.frames.map((f) => /^event: (\S+)/.exec(f)?.[1] ?? '').filter(Boolean);

describe('SseConnection', () => {
  it('writes one framed event per enqueue', () => {
    const res = new FakeRes();
    const c = new SseConnection(asRes(res), 8, () => undefined);
    c.enqueue({ type: 'heartbeat' });
    c.enqueue({ type: 'inflight.settled', id: 'r1' });
    expect(types(res)).toEqual(['heartbeat', 'inflight.settled']);
    expect(res.frames[1]).toContain('"id":"r1"');
    expect(res.frames[1]?.endsWith('\n\n')).toBe(true);
  });

  it('collapses an overflowing backlog to a SINGLE resync (bounded memory)', async () => {
    const res = new FakeRes();
    res.accept = false; // socket asks us to wait → the queue builds
    const c = new SseConnection(asRes(res), 4, () => undefined);
    for (let i = 0; i < 50; i += 1) c.enqueue({ type: 'inflight.settled', id: `r${String(i)}` });
    // Hard ceiling: the queue never grows past the bound, and the backlog is dropped
    // rather than buffered.
    expect(c.pending).toBeLessThanOrEqual(4);
    res.accept = true;
    res.emit('drain');
    // The write loop resumes on a microtask after the drain resolves.
    await Promise.resolve();
    await Promise.resolve();
    // Further deltas are meaningless until the client re-snapshots.
    expect(types(res)).toContain('resync');
    // Exactly ONE resync — the backlog collapsed rather than replayed.
    expect(types(res).filter((t) => t === 'resync')).toHaveLength(1);
  });

  it('drops queued frames on close rather than flushing them', () => {
    const res = new FakeRes();
    res.accept = false;
    const c = new SseConnection(asRes(res), 16, () => undefined);
    c.enqueue({ type: 'inflight.settled', id: 'r1' });
    c.enqueue({ type: 'inflight.settled', id: 'r2' });
    const before = res.frames.length;
    c.close('authorization_revoked');
    expect(c.pending).toBe(0); // the latch: dropped, never flushed
    res.accept = true;
    res.emit('drain');
    expect(res.frames.length).toBe(before); // nothing written after the close
    expect(res.writableEnded).toBe(true);
  });

  it('is idempotent on close and notifies its owner exactly once', () => {
    const res = new FakeRes();
    let closes = 0;
    const c = new SseConnection(asRes(res), 8, () => void (closes += 1));
    c.close('a');
    c.close('b');
    expect(closes).toBe(1);
    expect(c.isClosed).toBe(true);
  });
});
