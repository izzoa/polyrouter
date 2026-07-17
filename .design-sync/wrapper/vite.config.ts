// Stage 1 of the design-kit build: compile the app's SolidJS sources (components,
// pages, state, fake data layer) with the repo's own toolchain (vite-plugin-solid)
// into one ESM lib + one CSS file. Stage 2 (tsc) compiles the React adapters that
// mount this output. solid-js and uplot stay external — the design-sync converter
// bundles a single copy of each from this package's node_modules.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import solid from 'vite-plugin-solid';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(here, '../../packages/frontend');
const APP_VERSION = (
  JSON.parse(readFileSync(resolve(FRONTEND, 'package.json'), 'utf8')) as { version: string }
).version;

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [solid()],
  resolve: {
    alias: {
      '@polyrouter/shared': resolve(here, '../../packages/shared/dist/index.mjs'),
    },
  },
  build: {
    outDir: 'solid',
    emptyOutDir: true,
    cssCodeSplit: false,
    minify: false,
    lib: {
      entry: resolve(here, 'solid-src/lib.tsx'),
      formats: ['es'],
      fileName: () => 'design-kit.mjs',
      cssFileName: 'design-kit',
    },
    rollupOptions: {
      external: [/^solid-js/, 'uplot'],
    },
  },
});
