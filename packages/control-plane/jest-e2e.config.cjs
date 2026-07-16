/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'],
  // Spawned-process tests (boot fail-fast, prod topology via `npm start`) are slow.
  testTimeout: 120000,
  // No forceExit (ci-pipeline spec): every suite must release its resources so
  // the runner exits on its own — a leak surfaces as a visible hang/failure
  // (bounded by CI job timeouts) instead of being masked.
};
