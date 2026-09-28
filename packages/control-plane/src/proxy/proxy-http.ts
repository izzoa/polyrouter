import type { AgentCalibrationAttachment } from '../auth/agent-key.guard';
import type { Request, Response } from 'express';
import type { Principal } from '@polyrouter/shared/server';
import type { ClientProtocol } from './proxy-errors';
import { asProxyError, proxyErrorFrame, serviceUnavailable } from './proxy-errors';
import type { StreamKeepaliveConfig } from './proxy.config';
import { IdleTimer, isTerminalFrame, keepaliveFrame } from './stream-keepalive';
import type { ProxyService } from './proxy.service';
import type { StreamDrainRegistry } from './stream-drain.registry';

export interface ProxyHttpDeps {
  readonly svc: ProxyService;
  readonly registry: StreamDrainRegistry;
  /** `/v1` stream keepalive + early response commit (add-stream-keepalive). Absent =
   * both disabled (today's wire behavior, headers aside). */
  readonly keepalive?: StreamKeepaliveConfig;
}

const KEEPALIVE_DISABLED: StreamKeepaliveConfig = { heartbeatMs: 0, earlyCommitMs: 0 };

/** Branch streaming vs buffered on the request body's `stream` flag. Throws a
 * ProxyError (rendered by the exception filter) on any pre-commit failure. */
export async function handleInference(
  deps: ProxyHttpDeps,
  protocol: ClientProtocol,
  principal: Principal,
  body: unknown,
  req: Request,
  res: Response,
): Promise<void> {
  // Refuse ALL new inference (streaming or not) once shutdown has begun.
  if (deps.registry.isDraining()) throw serviceUnavailable('server is shutting down');
  const agentId = (req as { agentId?: string }).agentId ?? null;
  // add-per-agent-calibration: attached by the agent-key guard from the record
  // it already read. Null for a session-plane caller, which has no agent pair.
  const agentCalibration =
    (req as { agentCalibration?: AgentCalibrationAttachment }).agentCalibration ?? null;
  const streaming = (body as { stream?: unknown } | null)?.stream === true;
  if (!streaming) {
    // Wire client disconnect to an abort so a buffered fallback walk stops.
    const abort = new AbortController();
    const onClose = (): void => abort.abort();
    res.on('close', onClose);
    try {
      const wire = await deps.svc.completion(
        principal,
        protocol,
        body,
        req.headers,
        agentId,
        abort.signal,
        agentCalibration,
      );
      res.status(200).json(wire); // a completion is 200, not Nest's POST-default 201
    } finally {
      res.off('close', onClose);
    }
    return;
  }
  await pumpSse(deps, protocol, principal, body, req, res, agentId, agentCalibration);
}

async function pumpSse(
  deps: ProxyHttpDeps,
  protocol: ClientProtocol,
  principal: Principal,
  body: unknown,
  req: Request,
  res: Response,
  agentId: string | null,
  agentCalibration: AgentCalibrationAttachment | null,
): Promise<void> {
  if (deps.registry.isDraining()) throw serviceUnavailable('server is shutting down');
  const ka = deps.keepalive ?? KEEPALIVE_DISABLED;

  const abort = new AbortController();
  const onClose = (): void => abort.abort();
  res.on('close', onClose);
  deps.registry.register(abort);

  let frames: AsyncGenerator<string> | undefined;
  // Set once a frame carrying the stream's terminator ([DONE] / message_stop / an
  // error event) has been written: no keepalive may follow it, even while the
  // upstream generator still awaits its own teardown (add-stream-keepalive).
  let terminal = false;
  let firstEventWritten = false;
  let earlyTimer: NodeJS.Timeout | undefined;
  const open = (): boolean =>
    !terminal && !abort.signal.aborted && !res.writableEnded && !res.destroyed;
  // A keepalive is written only when the socket can take it: while it needs a drain
  // it is SKIPPED, never queued (invariant 12). The timer re-arms every tick either
  // way, so a skip never ends the heartbeat.
  // EVERY keepalive — the heartbeat's and the early commit's first — goes through
  // this one guard: written only while the response is open and the socket can take
  // it; otherwise skipped, never queued.
  const writeKeepalive = (): void => {
    if (!open() || res.writableNeedDrain) return;
    res.write(keepaliveFrame(protocol, firstEventWritten));
  };
  const heartbeat = new IdleTimer(ka.heartbeatMs, writeKeepalive);
  const commitHeaders = (): void => {
    if (res.headersSent) return;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // A buffering reverse proxy (nginx's default) would hold keepalives and events.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
  };

  try {
    // ---- Pre-commit: wait for the first successful event. It races (a) the early-
    // commit timer — a transport preamble (200 + SSE headers + comment keepalives,
    // NO model bytes) so idle-reaping intermediaries keep the connection while
    // fallback/cascade continue — and (b) the abort signal, so a client close or a
    // shutdown-drain abort ends the response at once instead of waiting on an
    // upstream that may ignore cancellation (invariant 12).
    const streamP = deps.svc.stream(
      principal,
      protocol,
      body,
      req.headers,
      abort.signal,
      agentId,
      agentCalibration,
    );
    const outcome = await new Promise<
      | { readonly kind: 'ok'; readonly frames: AsyncGenerator<string> }
      | { readonly kind: 'error'; readonly error: unknown }
      | { readonly kind: 'aborted' }
    >((resolve) => {
      streamP.then(
        (f) => resolve({ kind: 'ok', frames: f }),
        (error: unknown) => resolve({ kind: 'error', error }),
      );
      if (abort.signal.aborted) resolve({ kind: 'aborted' });
      else
        abort.signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true });
      if (ka.earlyCommitMs > 0) {
        earlyTimer = setTimeout(() => {
          earlyTimer = undefined;
          if (!open()) return;
          commitHeaders();
          if (ka.heartbeatMs > 0) {
            writeKeepalive();
            heartbeat.arm();
          }
        }, ka.earlyCommitMs);
      }
    });
    clearTimeout(earlyTimer); // settled by any route: a stale timer must never commit
    earlyTimer = undefined;

    if (outcome.kind === 'aborted') {
      // Detached: the pending call settles on its own (its rejection is handled
      // above); a late success still releases its upstream iterator.
      streamP.then(
        (f) => void f.return?.(undefined).catch(() => undefined),
        () => undefined,
      );
      return;
    }
    if (outcome.kind === 'error') {
      // Before an early commit: a clean protocol-shaped HTTP error (the filter).
      if (!res.headersSent) throw outcome.error;
      // After it: the SAME mapped error, delivered as one in-stream frame.
      heartbeat.stop();
      if (open()) res.write(proxyErrorFrame(protocol, asProxyError(outcome.error)));
      terminal = true;
      return;
    }

    frames = outcome.frames;
    commitHeaders(); // a no-op after an early commit

    // ---- Committed: pump frames with backpressure; the heartbeat covers silence.
    heartbeat.arm();
    for (;;) {
      const next = await frames.next(); // exactly one pending pull at a time
      if (next.done) break;
      if (res.writableEnded || abort.signal.aborted) break;
      const ok = res.write(next.value);
      firstEventWritten = true;
      if (isTerminalFrame(protocol, next.value)) {
        terminal = true;
        heartbeat.stop();
      } else {
        heartbeat.arm(); // a write resets the idle clock
      }
      if (!ok) await drain(res, abort.signal);
    }
  } finally {
    // One teardown for every path (pre-commit, early commit, pump). Snapshot whether
    // the abort came from OUTSIDE this finally (the drain deadline aborted the stream,
    // or the client's 'close' fired) BEFORE we self-cancel below — otherwise the
    // post-abort signal is always aborted and a normally-completed stream would be
    // wrongly destroyed/truncated (E1.2).
    heartbeat.stop();
    clearTimeout(earlyTimer);
    const externallyAborted = abort.signal.aborted;
    res.off('close', onClose);
    deps.registry.deregister(abort);
    abort.abort(); // ensure the upstream is cancelled
    await frames?.return?.(undefined);
    if (externallyAborted) {
      // Deadline-drained or client-severed: destroy so a write-blocked socket is
      // released and httpServer.close() can resolve (no hang). A client 'close'
      // may already have destroyed it — then there is nothing to do.
      if (!res.destroyed) res.destroy();
    } else if (res.headersSent && !res.writableEnded) {
      res.end(); // normal completion (or an in-stream error) — flush and end cleanly
    }
    // Headers never sent and not aborted: a fast pre-commit failure, rethrown above
    // for the /v1 exception filter to render — the response is left to it.
  }
}

/** Resolve on `drain` OR `close`/`error` OR the pump's `abort` so neither a
 * client disconnect nor a shutdown-deadline abort can hang the write loop
 * waiting for a drain that will never come (E1.2). */
function drain(res: Response, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      res.off('error', done);
      signal.removeEventListener('abort', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
    res.once('error', done);
    signal.addEventListener('abort', done, { once: true });
  });
}
