import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const fixture = join(__dirname, '..', 'dist', 'testing', 'boot-failfast.fixture.js');

interface SpawnResult {
  code: number | null;
  stderr: string;
}

function runFixture(env: NodeJS.ProcessEnv): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture], { env });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stderr });
    });
  });
}

describe('fail-fast boot (app-config)', () => {
  beforeAll(() => {
    if (!existsSync(fixture)) {
      throw new Error(`Fixture not built at ${fixture} — run \`npm run build\` first.`);
    }
  });

  it('exits non-zero naming the missing required variable, before serving traffic', async () => {
    const { code, stderr } = await runFixture({
      PATH: process.env['PATH'],
    });
    expect(code).toBe(1);
    expect(stderr).toContain('Invalid configuration');
    expect(stderr).toContain('TEST_REQUIRED_TOKEN');
  });

  it('reports an invalid enum without echoing the supplied value', async () => {
    const suppliedValue = 'super-secret-value-123';
    const { code, stderr } = await runFixture({
      PATH: process.env['PATH'],
      TEST_REQUIRED_TOKEN: 'present',
      MODE: suppliedValue,
    });
    expect(code).toBe(1);
    expect(stderr).toContain('MODE');
    expect(stderr).not.toContain(suppliedValue);
  });
});
