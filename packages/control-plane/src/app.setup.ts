import { ValidationPipe, type INestApplication } from '@nestjs/common';
import type { BaseConfig } from '@polyrouter/shared';

/**
 * Applies the app-wide behavior main() and the e2e suites must share, so
 * tests exercise the exact wiring production runs:
 * - global ValidationPipe (`whitelist`, `forbidNonWhitelisted`) on all input
 * - CORS only in development (the Vite dev server on :3000 is cross-origin;
 *   in production the SPA is same-origin, so no CORS headers are emitted)
 */
export function configureApp(
  app: INestApplication,
  config: Pick<BaseConfig, 'NODE_ENV'>,
  dashboardOrigin?: string,
): INestApplication {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  if (config.NODE_ENV === 'development') {
    // CORS pinned to the exact dashboard origin (not reflect-any-origin), so a
    // hostile page cannot ride the session cookie cross-origin (auth #3).
    app.enableCors({ origin: dashboardOrigin ?? 'http://localhost:3000', credentials: true });
  }
  return app;
}
