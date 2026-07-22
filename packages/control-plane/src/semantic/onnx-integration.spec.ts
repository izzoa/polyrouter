import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOnnxRuntime, loadWithOrt, type OrtLike } from './onnx-loader';
import type { SemanticConfig } from './semantic.config';
import { FIXTURE_MANIFEST, FIXTURE_VOCAB, buildFixtureModel } from './testing/onnx-fixture';

/**
 * Real-runtime integration (task 3.5, clink r1 High-2), split across the
 * jest VM-realm boundary: jest sandboxes modules in a VM context whose
 * `Float32Array` differs from the host realm's, which breaks real ORT's
 * output `instanceof` checks in-process. So:
 *  - the FULL loader pipeline (bundle → tokenizer → session → warmup → id)
 *    runs in-process against a fake ORT module (realm-safe), and
 *  - REAL native inference on the hand-built fixture graph runs in a spawned
 *    child process (one realm), asserting exact output numbers on Node 24.
 * Session CREATE from real ORT happens before any output wrapping, so the
 * corrupt-model named-error path stays a real in-process test.
 */
const hasOrt = ((): boolean => {
  try {
    require.resolve('onnxruntime-node');
    return true;
  } catch {
    return false;
  }
})();

if (!hasOrt) {
  console.warn('onnxruntime-node not installed — skipping semantic real-runtime integration');
}

const cfg = (modelPath: string): SemanticConfig => ({
  modelPath,
  timeoutMs: 1000, // generous: CI machines JIT the first inference slowly
  maxInputChars: 2000,
  concurrency: 2,
  highThreshold: 0.15,
  lowThreshold: 0.15,
  learning: {
    minCohort: 8,
    minSamples: 50,
    alpha: 0.2,
    maxDrift: 0.35,
    cooldownH: 24,
    stateTtlD: 30,
    maxCohorts: 4096,
    schedEnabled: true,
    schedCron: '0 3 * * *',
  },
});

/** Realm-safe fake ORT: run() emits `[id_t × dims]` per token, like the fixture graph. */
const fakeOrt = (): OrtLike => ({
  InferenceSession: {
    create: (bytes) => {
      if (bytes.length < 8) return Promise.reject(new Error('model too small'));
      return Promise.resolve({
        run: (
          feeds: Record<string, { data: ArrayLike<number | bigint>; dims: readonly number[] }>,
        ) => {
          const ids = Array.from(feeds['input_ids']?.data ?? [], Number);
          const dims = FIXTURE_MANIFEST.model.dims;
          const data = new Float32Array(ids.length * dims);
          ids.forEach((id, t) => {
            for (let d = 0; d < dims; d += 1) data[t * dims + d] = id;
          });
          return Promise.resolve({ out: { data, dims: [1, ids.length, dims] } });
        },
      });
    },
  },
  Tensor: class {
    constructor(
      _type: string,
      public readonly data: BigInt64Array,
      public readonly dims: number[],
    ) {}
  } as OrtLike['Tensor'],
});

describe('semantic loader pipeline (fake ORT, full path incl. warmup + content id)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'poly-semantic-'));
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(FIXTURE_MANIFEST));
    await writeFile(join(dir, 'vocab.txt'), FIXTURE_VOCAB);
    await writeFile(join(dir, 'model.onnx'), buildFixtureModel());
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads the bundle, warms up, and embeds deterministically', async () => {
    const { embedder, warmupMs } = await loadWithOrt(cfg(dir), fakeOrt);
    expect(embedder.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(embedder.dims).toBe(8);
    expect(warmupMs).toBeGreaterThanOrEqual(0);
    // token t → [id_t ×8]; mean-pool + L2-normalize → every dim = 1/√8.
    const v = await embedder.embed('route this request');
    expect(v).toHaveLength(8);
    for (const x of v) expect(x).toBeCloseTo(Math.sqrt(1 / 8), 5);
  });

  it('the content-derived id changes when a bundle byte changes', async () => {
    const a = (await loadWithOrt(cfg(dir), fakeOrt)).embedder.id;
    const dir2 = await mkdtemp(join(tmpdir(), 'poly-semantic-b-'));
    try {
      await writeFile(join(dir2, 'manifest.json'), JSON.stringify(FIXTURE_MANIFEST));
      await writeFile(join(dir2, 'vocab.txt'), `${FIXTURE_VOCAB}\nextra`);
      await writeFile(join(dir2, 'model.onnx'), buildFixtureModel());
      const b = (await loadWithOrt(cfg(dir2), fakeOrt)).embedder.id;
      expect(b).not.toBe(a);
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it('same bytes at a different mount path produce the SAME id', async () => {
    const dir3 = await mkdtemp(join(tmpdir(), 'poly-semantic-c-'));
    try {
      await writeFile(join(dir3, 'manifest.json'), JSON.stringify(FIXTURE_MANIFEST));
      await writeFile(join(dir3, 'vocab.txt'), FIXTURE_VOCAB);
      await writeFile(join(dir3, 'model.onnx'), buildFixtureModel());
      const a = (await loadWithOrt(cfg(dir), fakeOrt)).embedder.id;
      const c = (await loadWithOrt(cfg(dir3), fakeOrt)).embedder.id;
      expect(c).toBe(a);
    } finally {
      await rm(dir3, { recursive: true, force: true });
    }
  });
});

(hasOrt ? describe : describe.skip)('real onnxruntime-node (Node 24, exact-pinned devDep)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'poly-semantic-real-'));
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(FIXTURE_MANIFEST));
    await writeFile(join(dir, 'vocab.txt'), FIXTURE_VOCAB);
    await writeFile(join(dir, 'model.onnx'), buildFixtureModel());
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs the fixture graph natively with exact outputs (child process — one realm)', () => {
    const runner = `
      const fs = require('fs'); const path = require('path');
      const [, dir, ortPath] = process.argv;
      const ort = require(ortPath);
      (async () => {
        const session = await ort.InferenceSession.create(
          fs.readFileSync(path.join(dir, 'model.onnx')), { executionProviders: ['cpu'] });
        const ids = [2n, 4n, 5n, 6n, 3n]; // [CLS] route this request [SEP]
        const feeds = {
          input_ids: new ort.Tensor('int64', BigInt64Array.from(ids), [1, 5]),
          attention_mask: new ort.Tensor('int64', BigInt64Array.from(ids.map(() => 1n)), [1, 5]),
        };
        const res = await session.run(feeds);
        console.log(JSON.stringify({ dims: res.out.dims, data: Array.from(res.out.data) }));
      })().catch((e) => { console.error((e && e.message) || String(e)); process.exit(1); });
    `;
    const ortEntry = require.resolve('onnxruntime-node');
    const result = spawnSync(process.execPath, ['-e', runner, dir, ortEntry], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    // onnxruntime-node emits benign device-discovery WARNINGS to stderr on some
    // hardware (e.g. CI runners whose PCI bus path doesn't match ORT's expected
    // pattern: `[W:onnxruntime:… GetPciBusId] Skipping pci_bus_id …`, ANSI-wrapped
    // on ONE line). Those are not failures — drop ORT warning lines (and blanks)
    // and assert nothing else remains, so a real error (`[E:`/`[F:`, a stack, our
    // catch's message) still fails the check while the CPU-only run stays clean.
    const stderrErrors = result.stderr
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.includes('[W:onnxruntime:'))
      .join('\n');
    expect(stderrErrors).toBe('');
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as { dims: number[]; data: number[] };
    expect(out.dims).toEqual([1, 5, 8]);
    // Fixture graph: token t → [id_t ×8]; row-major [seq, 8].
    const expected = [2, 4, 5, 6, 3].flatMap((id) => Array.from({ length: 8 }, () => id));
    expect(out.data).toEqual(expected);
  });

  it('a corrupt model file fails session create with a named, path-value-free error', async () => {
    const dir4 = await mkdtemp(join(tmpdir(), 'poly-semantic-d-'));
    try {
      await writeFile(join(dir4, 'manifest.json'), JSON.stringify(FIXTURE_MANIFEST));
      await writeFile(join(dir4, 'vocab.txt'), FIXTURE_VOCAB);
      await writeFile(join(dir4, 'model.onnx'), Buffer.from('not an onnx model'));
      let message = '';
      try {
        await loadOnnxRuntime(cfg(dir4)); // REAL ORT: create rejects pre-realm
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain('model.onnx');
      expect(message).toContain('session create failed');
      expect(message).not.toContain(dir4);
    } finally {
      await rm(dir4, { recursive: true, force: true });
    }
  });
});
