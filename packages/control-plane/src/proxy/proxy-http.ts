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
    const wire = await deps.svc.completion(principal, protocol, body, req.headers, agentId);
    res.status(200).json(wire); // a completion is 200, not Nest's POST-default 201
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
      if (!res.write(frame)) await drain(res);
    }
  } finally {
    res.off('close', onClose);
    deps.registry.deregister(abort);
    abort.abort(); // ensure the upstream is cancelled
    await frames.return?.(undefined);
    if (!res.writableEnded) res.end();
  }
}

/** Resolve on `drain` OR `close`/`error` so a client disconnect can't hang the
 * write loop waiting for a drain that will never come. */
function drain(res: Response): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      res.off('error', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
    res.once('error', done);
  });
}
