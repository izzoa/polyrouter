import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FIXTURE_MANIFEST,
  FIXTURE_VOCAB,
  buildFixtureModel,
} from '../src/semantic/testing/onnx-fixture';

const fixture = join(__dirname, '..', 'dist', 'testing', 'semantic-boot.fixture.js');

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runFixture(env: NodeJS.ProcessEnv): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture], { env, timeout: 60_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

describe('semantic boot matrix (add-semantic-embedder D5)', () => {
  beforeAll(() => {
    if (!existsSync(fixture)) {
      throw new Error(`Fixture not built at ${fixture} — run \`npm run build\` first.`);
    }
  });

  it('unset path: boots, listens, capability false — the module is absent', async () => {
    const { code, stdout } = await runFixture({ PATH: process.env['PATH'] });
    expect(code).toBe(0);
    expect(stdout).toContain('LISTENING');
    expect(stdout).toContain('AVAILABLE:false');
  });

  it('broken path: boot rejects BEFORE binding, naming the variable + file, never the path value', async () => {
    const marker = 'SECRETMARKER-not-a-real-dir';
    const { code, stdout, stderr } = await runFixture({
      PATH: process.env['PATH'],
      SEMANTIC_MODEL_PATH: `/tmp/${marker}`,
    });
    expect(code).toBe(1);
    expect(stdout).not.toContain('LISTENING'); // the port never bound
    expect(stderr).toContain('SEMANTIC_MODEL_PATH');
    expect(stderr).toContain('manifest.json'); // the offending file's basename
    expect(stderr).not.toContain(marker); // the supplied path value is never echoed
  });

  it('valid bundle: loads the REAL runtime, warms up, and advertises the capability before serving', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'poly-semantic-boot-'));
    try {
      await writeFile(join(dir, 'manifest.json'), JSON.stringify(FIXTURE_MANIFEST));
      await writeFile(join(dir, 'vocab.txt'), FIXTURE_VOCAB);
      await writeFile(join(dir, 'model.onnx'), buildFixtureModel());
      const { code, stdout, stderr } = await runFixture({
        PATH: process.env['PATH'],
        SEMANTIC_MODEL_PATH: dir,
      });
      expect(stderr).toBe('');
      expect(code).toBe(0);
      expect(stdout).toContain('LISTENING');
      expect(stdout).toContain('AVAILABLE:true');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('out-of-bounds semantic env rejects at config validation (never clamped)', async () => {
    const { code, stderr } = await runFixture({
      PATH: process.env['PATH'],
      SEMANTIC_TIMEOUT_MS: '5000',
    });
    expect(code).toBe(1);
    expect(stderr).toContain('SEMANTIC_TIMEOUT_MS');
  });
});
