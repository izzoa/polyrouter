import { defineConfig } from 'vitest/config';
import { readReleaseVersion } from './build/release-version';

export default defineConfig({
  // Shared's own tests see the real release version, as the built bundle does.
  define: { __POLYROUTER_RELEASE_VERSION__: JSON.stringify(readReleaseVersion()) },
  test: {
    environment: 'node',
  },
});
