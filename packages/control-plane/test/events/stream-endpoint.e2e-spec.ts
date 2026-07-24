import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { userPrincipal, type InflightSnapshot, type Principal } from '@polyrouter/shared/server';
import { get as httpGet } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import type { AuthedRequest } from '../../src/auth/principal.decorator';
import { DashboardEvents, ownerKeyOf } from '../../src/events/dashboard-events';
import { DashboardStreamRegistry } from '../../src/events/dashboard-stream.registry';
import { EventsController } from '../../src/events/events.controller';
import { EVENTS_CONFIG, type EventsConfig } from '../../src/events/events.config';
import { STREAM_AUTHORIZER, type StreamAuthorizer } from '../../src/events/stream-authorizer';
import { InflightRegistry } from '../../src/inflight/inflight-registry';

/**
 * phase2-add-dashboard-event-stream — the endpoint contract at HTTP level: refusals
 * BEFORE any stream header, the snapshot-first handshake with its exactly-once
 * boundary, heartbeats, the per-owner cap, the draining refusal, and revocation of an
 * already-open stream.
 */

@Injectable()
class HeaderPrincipalGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const u = req.headers['x-test-user'];
    if (typeof u === 'string' && u.length > 0) {
      req.principal = userPrincipal(u);
      return true;
    }
    throw new UnauthorizedException();
  }
}

/** Controls what the registry reports, and lets a test delay the snapshot read so a
 * transition can land INSIDE the read window. */
class FakeRegistry {
  snapshot: InflightSnapshot = { items: [], available: true, truncated: false };
  onRead: (() => void) | null = null;
  delayMs = 0;
  async list(): Promise<InflightSnapshot> {
    this.onRead?.();
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    return this.snapshot;
  }
}

class FakeAuthorizer implements StreamAuthorizer {
  /** `undefined` = still authorized (echo the request's principal, the normal case);
   * `null` = authorization has lapsed; a Principal = it resolved to someone else. */
  result: Principal | null | undefined = undefined;
  revalidate(req: AuthedRequest): Promise<Principal | null> {
    if (this.result === undefined) return Promise.resolve(req.principal ?? null);
    return Promise.resolve(this.result);
  }
}

const CFG: EventsConfig = {
  enabled: true,
  heartbeatMs: 120,
  reconcileMs: 30_000,
  maxStreamsPerOwner: 2,
  queueLimit: 64,
  nudgeCoalesceMs: 1_000,
  revalidateMs: 80,
};

const row = (id: string) => ({
  id,
  startedAt: Date.now(),
  decisionLayer: 'cascade',
  tierAssigned: null,
  modelLabel: 'm',
  providerLabel: 'p',
  protocol: 'openai',
  status: 'running' as const,
});

describe('GET /api/events', () => {
  let app: NestExpressApplication;
  let bus: DashboardEvents;
  let streams: DashboardStreamRegistry;
  let registry: FakeRegistry;
  let authorizer: FakeAuthorizer;
  let cfg: EventsConfig;
  let port = 0;

  const build = async (over: Partial<EventsConfig> = {}): Promise<void> => {
    registry = new FakeRegistry();
    authorizer = new FakeAuthorizer();
    cfg = { ...CFG, ...over };
    const moduleRef = await Test.createTestingModule({
      controllers: [EventsController],
      providers: [
        DashboardEvents,
        DashboardStreamRegistry,
        { provide: EVENTS_CONFIG, useValue: cfg },
        { provide: InflightRegistry, useValue: registry },
        { provide: STREAM_AUTHORIZER, useValue: authorizer },
        { provide: APP_GUARD, useClass: HeaderPrincipalGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    await app.init();
    // A REAL listening socket: SSE needs incremental delivery, which supertest's
    // buffering response handling does not reliably give us.
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
    bus = app.get(DashboardEvents);
    streams = app.get(DashboardStreamRegistry);
  };

  afterEach(async () => {
    await app?.close();
  });

  /** Open a real SSE socket, collect frames for `ms`, then destroy it. */
  const sample = (
    user: string,
    ms: number,
    during?: () => void,
  ): Promise<{ body: string; status: number; headers: Record<string, string | string[] | undefined> }> =>
    new Promise((resolve) => {
      let body = '';
      const req = httpGet(
        { host: '127.0.0.1', port, path: '/api/events', headers: { 'x-test-user': user } },
        (res) => {
          res.setEncoding('utf8');
          res.on('data', (c: string) => {
            body += c;
          });
          const finish = (): void =>
            resolve({ body, status: res.statusCode ?? 0, headers: res.headers });
          setTimeout(() => during?.(), Math.min(30, ms / 3));
          setTimeout(() => {
            res.destroy();
            req.destroy();
            finish();
          }, ms);
        },
      );
      req.on('error', () => resolve({ body, status: 0, headers: {} }));
    });

  const events = (body: string): string[] =>
    [...body.matchAll(/^event: (\S+)$/gm)].map((m) => m[1] as string);

  it('sets the stream headers and sends the snapshot FIRST, with its authority flags', async () => {
    await build();
    registry.snapshot = { items: [row('r1')], available: true, truncated: false };
    const { body, headers } = await sample('u1', 80);
    expect(headers['content-type']).toContain('text/event-stream');
    expect(headers['cache-control']).toBe('no-cache, no-transform');
    expect(headers['connection']).toBe('keep-alive');
    // A buffering intermediary would otherwise make a live dashboard look frozen.
    expect(headers['x-accel-buffering']).toBe('no');
    const first = events(body)[0];
    expect(first).toBe('snapshot'); // FIRST, always
    // The flags are mandatory: the streamed handoff applies the same
    // authoritative-and-non-truncated test as the poll.
    expect(body).toContain('"available":true');
    expect(body).toContain('"truncated":false');
    expect(body).toContain(`"heartbeatIntervalMs":${String(cfg.heartbeatMs)}`);
    expect(body).toContain(`"reconciliationIntervalMs":${String(cfg.reconcileMs)}`);
  });

  it('reflects a transition landing INSIDE the snapshot read exactly once', async () => {
    await build();
    registry.delayMs = 40;
    registry.snapshot = { items: [], available: true, truncated: false };
    // Publish while the read is in flight: subscribe-before-read must not lose it,
    // and the prelude dedupe must not double-apply it.
    const { body } = await sample('u2', 200, () => {
      bus.publish(ownerKeyOf(userPrincipal('u2')), { type: 'inflight.started', row: row('mid') });
    });
    const started = [...body.matchAll(/"id":"mid"/g)];
    expect(started).toHaveLength(1); // exactly once — never lost, never doubled
    expect(events(body)[0]).toBe('snapshot');
  });

  it('does not duplicate a transition already present in the snapshot', async () => {
    await build();
    registry.delayMs = 40;
    registry.snapshot = { items: [row('dup')], available: true, truncated: false };
    const { body } = await sample('u3', 200, () => {
      bus.publish(ownerKeyOf(userPrincipal('u3')), { type: 'inflight.started', row: row('dup') });
    });
    // Present in the snapshot AND republished mid-read → the prelude entry is dropped.
    expect(events(body).filter((e) => e === 'inflight.started')).toHaveLength(0);
    expect([...body.matchAll(/"id":"dup"/g)]).toHaveLength(1);
  });

  it('emits NAMED heartbeat events on an idle stream (not comments)', async () => {
    await build({ heartbeatMs: 40 });
    const { body } = await sample('u4', 300);
    expect(events(body).filter((e) => e === 'heartbeat').length).toBeGreaterThanOrEqual(2);
    // A comment-only keep-alive would be invisible to EventSource in the browser.
    expect(body).not.toMatch(/^:/m);
  });

  it('refuses over-cap connections with 204 and no stream headers', async () => {
    await build({ maxStreamsPerOwner: 1 });
    const held = sample('u5', 400);
    await new Promise((r) => setTimeout(r, 60)); // let the first stream establish
    const res = await request(app.getHttpServer()).get('/api/events').set('x-test-user', 'u5');
    // 204 is the SSE-defined "do not reconnect" — a capped tab cannot tight-loop.
    expect(res.status).toBe(204);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).toBeUndefined(); // never a degenerate stream
    await held;
  });

  it('refuses with 204 when the stream is disabled instance-wide', async () => {
    await build({ enabled: false });
    const res = await request(app.getHttpServer()).get('/api/events').set('x-test-user', 'u6');
    expect(res.status).toBe(204);
    expect(res.headers['content-type']).toBeUndefined();
  });

  it('refuses a reconnect DURING the drain window with a retryable 503', async () => {
    await build();
    streams.onModuleDestroy(); // shutdown has begun; the server still listens
    expect(streams.isDraining()).toBe(true);
    const res = await request(app.getHttpServer()).get('/api/events').set('x-test-user', 'u7');
    // 503 (not 204): reconnecting to the REPLACEMENT process is what should happen.
    expect(res.status).toBe(503);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('closes an open stream at shutdown IMMEDIATELY (never waits)', async () => {
    await build();
    let ended = false;
    const req = request(app.getHttpServer())
      .get('/api/events')
      .set('x-test-user', 'u8')
      .buffer(false)
      .parse((r, cb) => {
        r.on('data', () => undefined);
        r.on('end', () => {
          ended = true;
          cb(null, '');
        });
      });
    void req.end(() => undefined);
    await new Promise((r) => setTimeout(r, 80));

    const start = Date.now();
    streams.onModuleDestroy();
    await new Promise((r) => setTimeout(r, 80));
    // The inference drain deadline is 15s; an open dashboard stream must not cost it.
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(ended).toBe(true);
  });

  it('revokes an OPEN stream when authorization lapses, delivering nothing after', async () => {
    await build({ revalidateMs: 40 });
    const key = ownerKeyOf(userPrincipal('u9'));
    authorizer.result = userPrincipal('u9'); // authorized at first
    const { body } = await sample('u9', 400, () => {
      // Session expires / user disabled: the next revalidation must observe it.
      authorizer.result = null;
      setTimeout(() => {
        // Published AFTER the latch: must never be delivered.
        bus.publish(key, { type: 'inflight.started', row: row('after-revoke') });
      }, 140);
    });
    expect(body).not.toContain('after-revoke');
    expect(bus.countFor(key)).toBe(0); // the stream was closed, not merely idled
  });

  it('revokes when revalidation resolves a DIFFERENT owner (not merely "some" principal)', async () => {
    await build({ revalidateMs: 40 });
    const key = ownerKeyOf(userPrincipal('u10'));
    authorizer.result = userPrincipal('someone-else');
    await sample('u10', 220);
    expect(bus.countFor(key)).toBe(0);
  });
});
