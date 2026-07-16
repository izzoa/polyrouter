import type { NestExpressApplication } from '@nestjs/platform-express';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { AUTH_INSTANCE } from './auth.tokens';
import { AuthRateLimitMiddleware } from './rate-limit.middleware';
import type { AuthInstance } from './better-auth';
import { DEFAULT_MAX_BODY_BYTES, PROXY_RUNTIME, type ProxyRuntime } from '../proxy/proxy.config';
import { protocolForPath, renderProxyError, requestTooLarge, badRequest } from '../proxy/proxy-errors';

/** The `/v1` body limit comes from the proxy runtime in production; auth-only
 * test harnesses mount body parsing without the proxy module, so fall back to
 * the default cap rather than requiring the DI token. */
function resolveMaxBodyBytes(app: NestExpressApplication): number {
  try {
    return app.get<ProxyRuntime>(PROXY_RUNTIME, { strict: false }).maxBodyBytes;
  } catch {
    return DEFAULT_MAX_BODY_BYTES;
  }
}

// Segment-safe so `/v10` or `/v1evil` are NOT treated as the proxy surface.
const isV1 = (path: string): boolean => path === '/v1' || path.startsWith('/v1/');

/**
 * Body parsing (E1.1). The `/v1` proxy surface accepts large bodies (real
 * harness payloads exceed body-parser's 100kb default) up to `maxBodyBytes`;
 * `/api` keeps the default limit so the pre-guard unauthenticated body window is
 * not enlarged. A `/v1`-scoped error handler renders body-parser failures
 * (oversized → 413, malformed → 400) in the caller's protocol envelope — these
 * fire in Express middleware before Nest, so the Nest exception filter never
 * sees them. Exported for direct testing against a bare Express app.
 */
export function mountBodyParsing(expressApp: express.Express, maxBodyBytes: number): void {
  const v1Json = express.json({ limit: maxBodyBytes });
  const apiJson = express.json();
  const v1Urlencoded = express.urlencoded({ extended: true, limit: maxBodyBytes });
  const apiUrlencoded = express.urlencoded({ extended: true });

  const routeByPath =
    (v1: RequestHandler, api: RequestHandler): RequestHandler =>
    (req, res, next) =>
      (isV1(req.path) ? v1 : api)(req, res, next);

  expressApp.use(routeByPath(v1Json, apiJson));
  expressApp.use(routeByPath(v1Urlencoded, apiUrlencoded));

  const bodyErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
    if (!isV1(req.path)) {
      next(err);
      return;
    }
    const type = (err as { type?: string }).type;
    const proxyErr =
      type === 'entity.too.large'
        ? requestTooLarge()
        : type === 'entity.parse.failed' || err instanceof SyntaxError
          ? badRequest('invalid request body')
          : null;
    if (proxyErr === null) {
      next(err);
      return;
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    const { status, body } = renderProxyError(proxyErr, protocolForPath(req.path));
    res.status(status).json(body);
  };
  expressApp.use(bodyErrorHandler);
}

/**
 * Mounts, in order, on the raw Express instance BEFORE body parsing:
 *   1. the auth rate limiter (must see the request before the handler),
 *   2. the Better Auth node handler for `/api/auth/*` (needs the raw body),
 *   3. path-routed JSON/urlencoded parsers + the `/v1` body-error handler.
 * The app is created with `bodyParser: false` so this ordering holds.
 */
export function mountAuth(app: NestExpressApplication): void {
  const expressApp = app.getHttpAdapter().getInstance();
  const authInstance = app.get<AuthInstance>(AUTH_INSTANCE);
  const rateLimiter = app.get(AuthRateLimitMiddleware);
  const maxBodyBytes = resolveMaxBodyBytes(app);

  expressApp.use((req, res, next) => {
    void rateLimiter.use(req, res, next);
  });

  expressApp.use((req, res, next) => {
    if (req.path.startsWith('/api/auth')) {
      authInstance.handler(req, res);
      return;
    }
    next();
  });

  mountBodyParsing(expressApp, maxBodyBytes);
}
