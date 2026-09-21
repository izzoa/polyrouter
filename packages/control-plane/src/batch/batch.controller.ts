import { Controller, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Principal } from '@polyrouter/shared/server';
import { AgentApiKeyGuard } from '../auth/agent-key.guard';
import { CurrentPrincipal } from '../auth/principal.decorator';
import {
  serviceUnavailable,
  stampClientProtocol,
  type ClientProtocol,
} from '../proxy/proxy-errors';
import { StreamDrainRegistry } from '../proxy/stream-drain.registry';
import { batchError, protocolForEndpoint } from './batch-errors';
import { BatchService } from './batch.service';

type BatchRequest = Request & { agentId?: string };

const agentOf = (req: Request): string | null => (req as BatchRequest).agentId ?? null;
const stamp = (req: Request, protocol: ClientProtocol): void => stampClientProtocol(req, protocol);

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * The batch routes on the agent-key plane (add-batch-inference task 3.6): the
 * same guard, both credential headers, the same `last_used_at` stamp and 401s as
 * the chat routes. `POST /v1/batches` reads the RAW request — the body parsers
 * step aside for exactly it (see `mountBodyParsing`) — and hands the stream to
 * the service, which parses, routes, prices, reserves and creates in the D6 order.
 */
@Controller('v1')
@UseGuards(AgentApiKeyGuard)
export class BatchController {
  constructor(
    private readonly svc: BatchService,
    private readonly registry: StreamDrainRegistry,
  ) {}

  @Post('batches')
  async submit(
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const abort = new AbortController();
    const onClose = (): void => abort.abort();
    res.on('close', onClose);
    try {
      const row = await this.svc.submit(
        principal,
        agentOf(req),
        req,
        { setProtocol: (p) => stamp(req, p) },
        abort.signal,
      );
      res.status(202).json(await this.svc.render(principal, row));
    } finally {
      res.off('close', onClose);
    }
  }

  @Get('batches')
  async list(
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const rawLimit = req.query['limit'];
    const parsedLimit = typeof rawLimit === 'string' ? Number.parseInt(rawLimit, 10) : NaN;
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(MAX_LIMIT, Math.max(1, parsedLimit))
      : DEFAULT_LIMIT;
    const rawAfter = req.query['after'];
    const after = typeof rawAfter === 'string' && rawAfter.length > 0 ? rawAfter : undefined;
    const page = await this.svc.list(principal, agentOf(req), {
      limit,
      ...(after !== undefined ? { after } : {}),
    });
    const data = await Promise.all(page.rows.map((row) => this.svc.render(principal, row)));
    res.status(200).json({
      object: 'list',
      data,
      first_id: page.rows[0]?.id ?? null,
      last_id: page.rows[page.rows.length - 1]?.id ?? null,
      has_more: page.nextCursor !== null,
    });
  }

  @Get('batches/:id')
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const row = await this.svc.get(principal, agentOf(req), id);
    if (row === null) throw batchError('batch_not_found');
    stamp(req, protocolForEndpoint(row.endpoint));
    res.status(200).json(await this.svc.render(principal, row));
  }

  /**
   * The results sub-resource (D25): JSONL, streamed from the upstream, never
   * stored. Beyond the buffered-response byte cap by construction — nothing here
   * accumulates — with backpressure to a slow client, an abort on disconnect, and
   * a drain on shutdown. A failure BEFORE the first byte is a protocol-shaped
   * error; after it, a terminal error object, never a silent truncation.
   */
  @Get('batches/:id/results')
  async results(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const found = await this.svc.get(principal, agentOf(req), id);
    if (found !== null) stamp(req, protocolForEndpoint(found.endpoint));
    if (this.registry.isDraining()) throw serviceUnavailable('server is shutting down');
    const abort = new AbortController();
    const onClose = (): void => abort.abort();
    res.on('close', onClose);
    this.registry.register(abort);
    let lines: AsyncGenerator<string>;
    try {
      // Pre-commit: a 409/410/404 renders in the caller's envelope, headers unsent.
      ({ lines } = await this.svc.results(principal, agentOf(req), id, abort.signal));
    } catch (err) {
      res.off('close', onClose);
      this.registry.deregister(abort);
      throw err;
    }
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-store');
    res.flushHeaders();
    let terminalError: string | null = null;
    try {
      for await (const line of lines) {
        if (res.writableEnded || abort.signal.aborted) break;
        if (!res.write(line)) await drain(res, abort.signal);
      }
    } catch {
      // Post-commit: the caller already has bytes, so the stream ends with an
      // explicit terminal object carrying a FIXED message (never upstream text).
      terminalError = `${JSON.stringify({
        error: {
          code: 'results_stream_failed',
          message: 'the provider stopped returning results for this batch',
        },
      })}\n`;
    } finally {
      const externallyAborted = abort.signal.aborted;
      res.off('close', onClose);
      this.registry.deregister(abort);
      abort.abort();
      await lines.return(undefined);
      if (externallyAborted) {
        if (!res.destroyed) res.destroy();
      } else {
        if (terminalError !== null && !res.writableEnded) res.write(terminalError);
        if (!res.writableEnded) res.end();
      }
    }
  }

  @Post('batches/:id/cancel')
  async cancel(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const found = await this.svc.get(principal, agentOf(req), id);
    if (found !== null) stamp(req, protocolForEndpoint(found.endpoint));
    const { row, changed } = await this.svc.cancel(principal, agentOf(req), id);
    res.status(changed ? 202 : 200).json(await this.svc.render(principal, row));
  }
}

/** Resolve on `drain` OR `close`/`error` OR the pump's `abort`, so neither a
 * client disconnect nor a shutdown-deadline abort can hang the write loop
 * waiting for a drain that will never come (the SSE pump's rule). */
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
