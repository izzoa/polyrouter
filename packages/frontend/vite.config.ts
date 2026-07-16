import solid from 'vite-plugin-solid';
import { defineConfig } from 'vitest/config';

// Dev topology (spec §4): Vite on :3000 proxies /api and /v1 to the backend
// on :3001 so the browser sees one origin. /v1 will carry SSE streams once the
// inference proxy lands (TODOS.md #10, spec §6.1) — http-proxy pipes responses
// without buffering by default; do NOT add buffering or proxyTimeout options
// here, or streamed tokens will stall.
const backendProxy = {
  target: 'http://localhost:3001',
  changeOrigin: false,
};

export default defineConfig({
  plugins: [solid()],
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      '/api': backendProxy,
      '/v1': backendProxy,
    },
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['./src/test/setup.ts'],
  },
});
