import { defineConfig } from 'tsup';
import { readReleaseVersion } from './build/release-version';

export default defineConfig({
  entry: { index: 'src/index.ts', server: 'src/server/index.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2023',
  // The release version, fixed when shared is built (add-honest-user-agent, design D2).
  define: { __POLYROUTER_RELEASE_VERSION__: JSON.stringify(readReleaseVersion()) },
});
