import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { Principal } from '@polyrouter/shared/server';
import type { Request, Response } from 'express';
import { CurrentPrincipal } from '../auth/principal.decorator';
import type { AuthedRequest } from '../auth/principal.decorator';
import { InflightRegistry } from '../inflight/inflight-registry';
import { DashboardEvents, ownerKeyOf, type DashboardEvent, type DashboardSubscriber } from './dashboard-events';
import { DashboardStreamRegistry } from './dashboard-stream.registry';
import { EVENTS_CONFIG, type EventsConfig } from './events.config';
import { SseConnection } from './sse-connection';
import { STREAM_AUTHORIZER, type StreamAuthorizer } from './stream-authorizer';

/**
 * `GET /api/events` — the ONE multiplexed dashboard event stream
 * (phase2-add-dashboard-event-stream).
 *
 * There is deliberately no second dashboard stream endpoint: a self-hosted instance
 * serves the SPA and API from one origin over plain HTTP (HTTP/1.1), where a browser
 * allows only ~6 concurrent connections per origin SHARED ACROSS ALL TABS — so each
 * open stream permanently consumes one of that shared pool. Every future push feature
 * multiplexes onto this endpoint.
 */
@Controller('api/events')
export class EventsController {
  constructor(
    private readonly events: DashboardEvents,
    private readonly streams: DashboardStreamRegistry,
    private readonly inflight: InflightRegistry,
    @Inject(STREAM_AUTHORIZER) private readonly authorizer: StreamAuthorizer,
    @Inject(EVENTS_CONFIG) private readonly cfg: EventsConfig,
  ) {}

  @Get()
  async stream(
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const key = ownerKeyOf(principal);

    // ---- Refusals run BEFORE any event-stream header or flushHeaders(): a refusal
    // must never be emitted as a degenerate stream.

    // Disabled instance-wide → permanent for this EventSource object. 204 is the
    // response the SSE algorithm defines as "do not reconnect", so a client cannot be
    // driven into a tight native reconnect loop. (A wrapper may still deliberately
    // construct a NEW EventSource after backoff — this is a no-tight-loop guarantee,
    // not an absolute block.)
    if (!this.cfg.enabled) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(204).end();
      return;
    }

    // Shutting down → RETRYABLE: reconnecting to the replacement process is exactly
    // what should happen, so 503 (not 204). Without this the HTTP server, which keeps
    // listening through the whole inference drain, would admit a fresh unbounded
    // stream on the dying process and pin httpServer.close().
    if (this.streams.isDraining()) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(503).end();
      return;
    }

    // Per-owner cap → permanent for this object (204): the tab stays on polling.
    if (this.events.countFor(key) >= this.cfg.maxStreamsPerOwner) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(204).end();
      return;
    }

    // ---- Establish the stream.
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // A buffering intermediary would otherwise make a live dashboard look frozen.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // A holder so the connection's close callback can capture these before they exist.
    const own: {
      heartbeat?: ReturnType<typeof setInterval>;
      revalidate?: ReturnType<typeof setInterval>;
      off?: () => void;
    } = {};

    const conn = new SseConnection(res, this.cfg.queueLimit, () => {
      if (own.heartbeat !== undefined) clearInterval(own.heartbeat);
      if (own.revalidate !== undefined) clearInterval(own.revalidate);
      own.off?.();
    });

    // SUBSCRIBE BEFORE READING THE SNAPSHOT, buffering arrivals — otherwise a
    // transition landing between the read and the subscribe is lost. The reverse
    // race (double-applying it) is handled by deduping the prelude against the
    // snapshot by id, so the entry is reflected EXACTLY ONCE either way.
    let ready = false;
    const prelude: DashboardEvent[] = [];
    const sub: DashboardSubscriber = {
      enqueue: (event) => {
        if (ready) conn.enqueue(event);
        else prelude.push(event);
      },
      close: (reason) => conn.close(reason),
    };
    own.off = this.events.subscribe(key, sub);

    res.on('close', () => conn.close('client_closed'));

    const snap = await this.inflight.list(principal);
    if (conn.isClosed) return;

    conn.enqueue({
      type: 'snapshot',
      items: snap.items,
      // The streamed handoff applies the SAME authoritative-and-non-truncated test
      // as the poll, so these flags are mandatory: a degraded or capped snapshot must
      // retain absent cached ids rather than settle them.
      available: snap.available,
      truncated: snap.truncated,
      // Advertised so the client derives its health window and reconciliation cadence
      // from the server's real config instead of assuming defaults.
      heartbeatIntervalMs: this.cfg.heartbeatMs,
      reconciliationIntervalMs: this.cfg.reconcileMs,
    });

    const inSnapshot = new Set(snap.items.map((i) => i.id));
    for (const event of prelude) {
      // A `started` already present in the snapshot would be a duplicate.
      if (event.type === 'inflight.started' && inSnapshot.has(event.row.id)) continue;
      conn.enqueue(event);
    }
    ready = true;

    // A NAMED heartbeat event, never an SSE comment: `EventSource` does not surface
    // comment frames to JS, so a comment-only keep-alive would make the client's
    // health check unimplementable.
    own.heartbeat = setInterval(() => conn.enqueue({ type: 'heartbeat' }), this.cfg.heartbeatMs);
    own.heartbeat.unref?.();

    // Authorization is revalidated for the LIFE of the stream: the guard runs once
    // per request and this is one long request, so without this an expired session or
    // a disabled user would keep receiving metadata indefinitely on a page with no
    // other guarded traffic — contradicting "disable cuts BOTH planes". Same code path
    // as the guard, and it must still be the ORIGINALLY SUBSCRIBED owner.
    own.revalidate = setInterval(() => {
      void (async () => {
        try {
          const still = await this.authorizer.revalidate(req as AuthedRequest);
          if (still !== null && ownerKeyOf(still) === key) return;
          this.events.revoke(key, 'authorization_revoked');
        } catch {
          this.events.revoke(key, 'authorization_check_failed');
        }
      })();
    }, this.cfg.revalidateMs);
    own.revalidate.unref?.();
  }
}
