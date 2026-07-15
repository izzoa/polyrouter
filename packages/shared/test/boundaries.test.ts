import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';
import { boundaryRulesFor } from '../../../eslint.boundaries.mjs';

/**
 * Proves the workspace dependency matrix (design decision 2) with the exact
 * rule objects eslint.config.mjs applies — covering the reverse edge and a
 * relative-path bypass, per tasks 4.2.
 */

const linter = new Linter();

function lint(
  packageKey: Parameters<typeof boundaryRulesFor>[0],
  code: string,
): Linter.LintMessage[] {
  return linter.verify(code, {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: boundaryRulesFor(packageKey),
  });
}

describe('workspace dependency matrix (monorepo-workspace)', () => {
  it('rejects the reverse edge: data-plane importing control-plane by package name', () => {
    const messages = lint('data-plane', `import { AppModule } from '@polyrouter/control-plane';`);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]?.message).toContain('data-plane may import only');
  });

  it('rejects a relative-path bypass: frontend reaching into control-plane sources', () => {
    const messages = lint('frontend', `import { bootstrap } from '../../control-plane/src/main';`);
    expect(messages.length).toBeGreaterThan(0);
  });

  it('rejects shared importing any workspace package', () => {
    expect(lint('shared', `import '@polyrouter/data-plane';`).length).toBeGreaterThan(0);
    expect(lint('shared', `import '../../frontend/src/App';`).length).toBeGreaterThan(0);
  });

  it('rejects control-plane importing frontend, by package name and deep path', () => {
    expect(lint('control-plane', `import '@polyrouter/frontend';`).length).toBeGreaterThan(0);
    expect(
      lint('control-plane', `import '../../frontend/dist/assets/index.js';`).length,
    ).toBeGreaterThan(0);
  });

  it('allows the edges the matrix permits', () => {
    expect(lint('data-plane', `import { APP_NAME } from '@polyrouter/shared';`)).toHaveLength(0);
    expect(
      lint('control-plane', `import { DataPlaneModule } from '@polyrouter/data-plane';`),
    ).toHaveLength(0);
    expect(lint('frontend', `import { APP_NAME } from '@polyrouter/shared';`)).toHaveLength(0);
    expect(lint('shared', `import { z } from 'zod';`)).toHaveLength(0);
  });

  it('forbids the frontend from reaching @polyrouter/shared/server in every form', () => {
    const forbidden = [
      `import { users } from '@polyrouter/shared/server';`,
      `import { encryptSecret } from '@polyrouter/shared/server/security/encryption';`,
      `import { users } from '../../shared/src/server/db/schema';`,
      `import '../../shared/dist/server.js';`,
    ];
    for (const code of forbidden) {
      const messages = lint('frontend', code);
      expect(messages.length).toBeGreaterThan(0);
    }
  });

  it('allows the backend packages to import the server entrypoint', () => {
    expect(
      lint('control-plane', `import { users } from '@polyrouter/shared/server';`),
    ).toHaveLength(0);
    expect(
      lint('data-plane', `import { PERSISTENCE_PORT } from '@polyrouter/shared/server';`),
    ).toHaveLength(0);
  });
});
