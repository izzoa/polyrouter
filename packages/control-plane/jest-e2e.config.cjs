/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'],
  // Spawned-process tests (boot fail-fast, prod topology via `npm start`) are slow.
  testTimeout: 120000,
  // BullMQ workers (#15a) keep the loop alive briefly after close; force-exit once
  // all suites + afterAll hooks finish so a run can't linger as a job-stealing zombie.
  forceExit: true,
};
