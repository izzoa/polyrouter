import { ArgumentsHost, Catch, HttpException, UnauthorizedException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Request, Response } from 'express';
import {
  ProxyError,
  internalError,
  protocolForPath,
  renderProxyError,
  toProxyError,
  stampedProtocol,
  unauthorized,
} from './proxy-errors';
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
    const proxyErr = this.asProxyError(exception);
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

  private asProxyError(exception: unknown): ProxyError {
    if (exception instanceof ProxyError) return exception;
    if (exception instanceof UnauthorizedException) return unauthorized();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // Fixed, non-leaking message by status class (never Nest's default body).
      if (status === 401) return unauthorized();
      const message = status < 500 ? 'invalid request' : 'internal proxy error';
      const type = status < 500 ? 'invalid_request_error' : 'api_error';
      return new ProxyError(status, message, type, null);
    }
    // Unknown thrown value (incl. a #6 ProviderError) → mapped or generic 500.
    const mapped = toProxyError(exception);
    return mapped instanceof ProxyError ? mapped : internalError();
  }
}
