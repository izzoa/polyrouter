import { defineConfig } from '@playwright/test';

/** Responsive browser suite (phase1-responsive-dashboard-layout, group 8).
 *
 * happy-dom performs no layout, so the unit suites can only assert declarations. These
 * tests measure the real thing: document overflow, bounding boxes, and hit rectangles.
 *
 * Dev-only. The app ships nothing from here — `browser-harness.html` is excluded from the
 * production build (see vite.config.ts) and this config is never part of an image. */
export default defineConfig({
  testDir: './browser',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  reporter: process.env['CI'] === undefined ? 'list' : 'github',
  use: {
    baseURL: 'http://localhost:4321',
    // Determinism: the suite asserts geometry, so animation must not be in flight when a
    // measurement is taken. This also exercises the shipped reduced-motion guard.
    contextOptions: { reducedMotion: 'reduce' },
  },
  webServer: {
    command: 'npx vite --port 4321 --strictPort',
    url: 'http://localhost:4321/browser-harness.html',
    reuseExistingServer: process.env['CI'] === undefined,
    timeout: 60_000,
  },
});
