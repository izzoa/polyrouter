import type { Request, Response } from 'express';
import type { Principal } from '@polyrouter/shared/server';
import type { ClientProtocol } from './proxy-errors';
import { serviceUnavailable } from './proxy-errors';
import type { ProxyService } from './proxy.service';
import type { StreamDrainRegistry } from './stream-drain.registry';

export interface ProxyHttpDeps {
  readonly svc: ProxyService;
  readonly registry: StreamDrainRegistry;
}

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
      );
      res.status(200).json(wire); // a completion is 200, not Nest's POST-default 201
    } finally {
      res.off('close', onClose);
    }
    return;
  }
  await pumpSse(deps, protocol, principal, body, req, res, agentId);
}

async function pumpSse(
  deps: ProxyHttpDeps,
  protocol: ClientProtocol,
  principal: Principal,
  body: unknown,
  req: Request,
  res: Response,
  agentId: string | null,
): Promise<void> {
  if (deps.registry.isDraining()) throw serviceUnavailable('server is shutting down');

  const abort = new AbortController();
  const onClose = (): void => abort.abort();
  res.on('close', onClose);
  deps.registry.register(abort);

  let frames: AsyncGenerator<string>;
  try {
    // Awaits the first successful event — a pre-commit failure throws here,
    // before any header is written, so the filter renders a clean HTTP error.
    frames = await deps.svc.stream(principal, protocol, body, req.headers, abort.signal, agentId);
  } catch (err) {
    res.off('close', onClose);
    deps.registry.deregister(abort);
    throw err;
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    for await (const frame of frames) {
      if (res.writableEnded || abort.signal.aborted) break;
      if (!res.write(frame)) await drain(res, abort.signal);
    }
  } finally {
    // Snapshot whether the abort came from OUTSIDE this finally (the drain
    // deadline aborted the stream, or the client's 'close' fired) BEFORE we
    // self-cancel below — otherwise the post-abort signal is always aborted and
    // a normally-completed stream would be wrongly destroyed/truncated (E1.2).
    const externallyAborted = abort.signal.aborted;
    res.off('close', onClose);
    deps.registry.deregister(abort);
    abort.abort(); // ensure the upstream is cancelled
    await frames.return?.(undefined);
    if (externallyAborted) {
      // Deadline-drained or client-severed: destroy so a write-blocked socket is
      // released and httpServer.close() can resolve (no hang). A client 'close'
      // may already have destroyed it — then there is nothing to do.
      if (!res.destroyed) res.destroy();
    } else if (!res.writableEnded) {
      res.end(); // normal completion — flush and end cleanly
    }
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
