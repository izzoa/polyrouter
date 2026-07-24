import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { userPrincipal, type Principal } from '@polyrouter/shared/server';
import { Redis } from 'ioredis';
import { DashboardEvents, ownerKeyOf } from '../../src/events/dashboard-events';
import { InflightTransitionsAdapter } from '../../src/events/inflight-transitions.adapter';
import { SseConnection } from '../../src/events/sse-connection';
import { InflightRegistry, type InflightEntry } from '../../src/inflight/inflight-registry';

/**
 * phase2-add-dashboard-event-stream — TENANT-ISOLATION REVIEW GATE (invariant 5).
 *
 * Exercises the real production publish path end to end: a real Redis-backed
 * `InflightRegistry` → the transitions adapter → the owner-keyed bus → two live
 * `SseConnection`s writing real SSE frames. Two owners hold concurrent streams while
 * both have requests in flight; neither stream may ever carry the other's entries,
 * ids, or nudges.
 *
 * (Scoped just below HTTP: the session guard and cookie plumbing are covered by the
 * auth e2e. What is proven here is the fanout itself, which is where isolation lives.)
 */
describe('dashboard stream isolation (real Redis)', () => {
  let client: Redis;
  let registry: InflightRegistry;
  let bus: DashboardEvents;

  class FakeRes extends EventEmitter {
    writableEnded = false;
    frames: string[] = [];
    write(chunk: string): boolean {
      this.frames.push(chunk);
      return true;
    }
    end(): void {
      this.writableEnded = true;
    }
  }

  const connect = (p: Principal): { res: FakeRes; conn: SseConnection; off: () => void } => {
    const res = new FakeRes();
    const conn = new SseConnection(res as unknown as Response, 256, () => undefined);
    const off = bus.subscribe(ownerKeyOf(p), conn);
    return { res, conn, off };
  };

  const frames = (res: FakeRes): { type: string; data: string }[] =>
    res.frames.map((f) => ({
      type: /^event: (\S+)/.exec(f)?.[1] ?? '',
      data: f.slice(f.indexOf('data: ') + 6),
    }));

  const entry = (over: Partial<InflightEntry> = {}): InflightEntry => ({
    requestId: randomUUID(),
    startedAt: Date.now(),
    decisionLayer: 'cascade',
    tierAssigned: 'utility',
    modelLabel: 'minimax/minimax-m3',
    providerLabel: 'Openrouter',
    protocol: 'openai',
    ...over,
  });

  const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

  beforeAll(() => {
    const url = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
    client = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: false });
    bus = new DashboardEvents();
    registry = new InflightRegistry(client, new InflightTransitionsAdapter(bus));
  });

  afterAll(async () => {
    await client.quit();
  });

  it('never leaks one owner\'s entries, ids, or nudges into another owner\'s stream', async () => {
    const a = userPrincipal(`u-stream-${randomUUID()}`);
    const b = userPrincipal(`u-stream-${randomUUID()}`);
    const sa = connect(a);
    const sb = connect(b);

    const ea = entry({ modelLabel: 'model-for-A' });
    const eb = entry({ modelLabel: 'model-for-B' });
    const la = registry.mark(a, ea);
    const lb = registry.mark(b, eb);
    await settled();

    // Each stream saw exactly its own start.
    expect(frames(sa.res).map((f) => f.type)).toEqual(['inflight.started']);
    expect(frames(sb.res).map((f) => f.type)).toEqual(['inflight.started']);
    expect(frames(sa.res)[0]?.data).toContain(ea.requestId);
    expect(frames(sa.res)[0]?.data).toContain('model-for-A');
    expect(frames(sa.res)[0]?.data).not.toContain(eb.requestId);
    expect(frames(sa.res)[0]?.data).not.toContain('model-for-B');
    expect(frames(sb.res)[0]?.data).toContain(eb.requestId);
    expect(frames(sb.res)[0]?.data).not.toContain(ea.requestId);

    // Settling is likewise owner-scoped.
    la.settle();
    await settled();
    const aTypes = frames(sa.res).map((f) => f.type);
    expect(aTypes).toEqual(['inflight.started', 'inflight.settled']);
    expect(frames(sa.res)[1]?.data).toContain(ea.requestId);
    // B's stream is untouched by A settling.
    expect(frames(sb.res).map((f) => f.type)).toEqual(['inflight.started']);

    // An owner-scoped analytics nudge reaches only its owner.
    bus.publishToOwner(b, { type: 'analytics.invalidated' });
    await settled();
    expect(frames(sb.res).map((f) => f.type)).toEqual([
      'inflight.started',
      'analytics.invalidated',
    ]);
    expect(frames(sa.res).map((f) => f.type)).not.toContain('analytics.invalidated');

    lb.settle();
    sa.off();
    sb.off();
  });

  it('publishes started/settled with METADATA ONLY (no body, credential, or vector)', async () => {
    const p = userPrincipal(`u-stream-${randomUUID()}`);
    const s = connect(p);
    const e = entry();
    const lease = registry.mark(p, e);
    await settled();
    lease.settle();
    await settled();

    const all = frames(s.res);
    const started = all.find((f) => f.type === 'inflight.started');
    const done = all.find((f) => f.type === 'inflight.settled');
    expect(started).toBeDefined();
    // Exactly the snapshot's per-entry metadata fields.
    const payload = JSON.parse(started!.data) as { row: Record<string, unknown> };
    expect(Object.keys(payload.row).sort()).toEqual(
      [
        'decisionLayer',
        'id',
        'modelLabel',
        'protocol',
        'providerLabel',
        'startedAt',
        'status',
        'tierAssigned',
      ].sort(),
    );
    // `settled` is deliberately ASYMMETRIC: the id only.
    expect(Object.keys(JSON.parse(done!.data) as Record<string, unknown>)).toEqual(['id']);
    s.off();
  });

  it('a registry transition still succeeds when the bus has no subscriber at all', async () => {
    const p = userPrincipal(`u-stream-${randomUUID()}`);
    const e = entry();
    // No stream connected: publication is a no-op and must never disturb the request.
    expect(() => registry.mark(p, e).settle()).not.toThrow();
    await settled();
    const snap = await registry.list(p);
    expect(snap.available).toBe(true);
  });
});
