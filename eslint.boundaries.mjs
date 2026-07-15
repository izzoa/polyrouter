/**
 * Workspace dependency matrix (spec §4; design decision 2):
 *
 *   shared        → (no workspace package)
 *   data-plane    → shared
 *   control-plane → shared + data-plane
 *   frontend      → shared
 *
 * Enforced for every import style — package name (`@polyrouter/x`), path alias,
 * and relative path — so the data-plane extraction (spec §3.3) stays lift-and-shift.
 * Consumed by eslint.config.mjs and unit-tested in packages/shared/test/boundaries.test.ts.
 */

const FORBIDDEN = {
  shared: ['control-plane', 'data-plane', 'frontend'],
  'data-plane': ['control-plane', 'frontend'],
  'control-plane': ['frontend'],
  frontend: ['control-plane', 'data-plane'],
};

const ALLOWED_DESC = {
  shared: 'no workspace package',
  'data-plane': 'only @polyrouter/shared',
  'control-plane': 'only @polyrouter/shared and @polyrouter/data-plane',
  frontend: 'only @polyrouter/shared',
};

function forbiddenPatterns(packageNames) {
  return packageNames.flatMap((name) => [
    `@polyrouter/${name}`,
    `@polyrouter/${name}/**`,
    `**/packages/${name}/**`,
    `**/${name}/src/**`,
    `**/${name}/dist/**`,
  ]);
}

/** Extra per-package restrictions beyond the package matrix. The shared
 * `./server` entrypoint (schema, tenancy, encryption — node-only) is
 * forbidden to the frontend in EVERY import form: package subpath, deep
 * source path, relative path, and built output. */
const EXTRA_RESTRICTIONS = {
  frontend: [
    {
      group: [
        '@polyrouter/shared/server',
        '@polyrouter/shared/server/**',
        '**/shared/src/server/**',
        '**/shared/dist/server*',
      ],
      message:
        'frontend must not import server-only shared code (@polyrouter/shared/server) in any form.',
    },
  ],
};

export function boundaryRulesFor(packageKey) {
  return {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: forbiddenPatterns(FORBIDDEN[packageKey]),
            message: `Workspace dependency matrix: ${packageKey} may import ${ALLOWED_DESC[packageKey]}.`,
          },
          ...(EXTRA_RESTRICTIONS[packageKey] ?? []),
        ],
      },
    ],
  };
}

export const boundaryConfigs = Object.keys(FORBIDDEN).map((packageKey) => ({
  name: `boundaries/${packageKey}`,
  files: [`packages/${packageKey}/**/*.{ts,tsx,mts,cts,js,mjs,cjs}`],
  rules: boundaryRulesFor(packageKey),
}));

export default boundaryConfigs;
