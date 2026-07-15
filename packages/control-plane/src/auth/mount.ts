import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { AUTH_INSTANCE } from './auth.tokens';
import { AuthRateLimitMiddleware } from './rate-limit.middleware';
import type { AuthInstance } from './better-auth';

/**
 * Mounts, in order, on the raw Express instance BEFORE body parsing:
 *   1. the auth rate limiter (must see the request before the handler),
 *   2. the Better Auth node handler for `/api/auth/*` (needs the raw body),
 *   3. JSON/urlencoded parsers for every other route.
 * The app is created with `bodyParser: false` so this ordering holds.
 */
export function mountAuth(app: NestExpressApplication): void {
  const expressApp = app.getHttpAdapter().getInstance();
  const authInstance = app.get<AuthInstance>(AUTH_INSTANCE);
  const rateLimiter = app.get(AuthRateLimitMiddleware);

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

  expressApp.use(express.json());
  expressApp.use(express.urlencoded({ extended: true }));
}
