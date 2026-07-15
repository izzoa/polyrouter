import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

/**
 * Production single-port topology (spec §3.1/§4): this process serves the
 * built SPA alongside the API. Static assets are served directly; any other
 * GET/HEAD falls back to the SPA shell so client-side routes deep-link —
 * except `/api/*` and `/v1/*`, which stay with the Nest router so unknown API
 * routes return real 404 JSON instead of HTML.
 *
 * The dist location assumes the §4 monorepo layout; packaging (#22) owns the
 * container layout and may relocate it.
 */
export function configureSpa(app: NestExpressApplication): void {
  const frontendDist = join(__dirname, '..', '..', 'frontend', 'dist');
  const indexHtml = join(frontendDist, 'index.html');

  if (!existsSync(indexHtml)) {
    console.warn(
      `[polyrouter] frontend build not found at ${frontendDist} — serving API only. Run \`npm run build\` to include the SPA.`,
    );
    return;
  }

  app.useStaticAssets(frontendDist, { index: false });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    const path = req.path;
    if (path === '/api' || path.startsWith('/api/') || path === '/v1' || path.startsWith('/v1/')) {
      next();
      return;
    }
    res.sendFile(indexHtml);
  });
}
