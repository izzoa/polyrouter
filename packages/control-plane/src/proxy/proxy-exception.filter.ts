import { ArgumentsHost, Catch } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Request, Response } from 'express';
import { asProxyError, protocolForPath, renderProxyError, stampedProtocol } from './proxy-errors';
import { isV1Path } from '../planes';

/**
 * Renders every `/v1` failure — the guard's 401, resolver/provider errors, a
 * body-parse 400 — in the caller's protocol envelope. Non-`/v1` paths delegate
 * to Nest's default handling so `/api` is unaffected. Post-commit stream errors
 * never reach here (they are terminal frames in the pump); if headers are
 * already sent we just end the response.
 */
@Catch()
export class ProxyExceptionFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    if (!isV1Path(req.path)) {
      super.catch(exception, host);
      return;
    }
    const res = ctx.getResponse<Response>();
    const proxyErr = asProxyError(exception);
    if (res.headersSent) {
      res.end();
      return;
    }
    // A route whose path cannot name the protocol stamps it once known — the
    // batch body's `endpoint`, the models surface's `anthropic-version` header.
    // Before that, and for every other /v1 path, the path decides.
    const stamped = stampedProtocol(req);
    const { status, body } = renderProxyError(proxyErr, stamped ?? protocolForPath(req.path));
    res.status(status).json(body);
  }
}
