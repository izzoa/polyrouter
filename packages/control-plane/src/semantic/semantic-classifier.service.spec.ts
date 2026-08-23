import { stubEmbedder, type Embedder } from '@polyrouter/data-plane';
import { DISABLED_LEARNING_GATE } from './classification-source';
import { SemanticClassifierService } from './semantic-classifier.service';
import { SemanticRuntimeService } from './semantic-runtime.service';
import type { SemanticConfig } from './semantic.config';

const CFG: SemanticConfig = {
  modelPath: '/x',
  timeoutMs: 50,
  maxInputChars: 2000,
  concurrency: 2,
  highThreshold: 0.15,
  lowThreshold: 0.15,
  workload: { margin: 0.05, minSim: 0.2 },
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
};

function fakeRuntime(embedder: Embedder | null): SemanticRuntimeService {
  return {
    embedder,
    config: CFG,
    whenReady: () => Promise.resolve(embedder),
  } as unknown as SemanticRuntimeService;
}

describe('SemanticClassifierService lifecycle', () => {
  it('module absent: stays unavailable, builds nothing', async () => {
    const svc = new SemanticClassifierService(fakeRuntime(null));
    await svc.onApplicationBootstrap();
    expect(svc.available).toBe(false);
    await expect(
      svc.resolve({ kind: 'user', userId: 'u' }, DISABLED_LEARNING_GATE),
    ).rejects.toThrow('not ready');
  });

  it('a real (separating) embedder builds centroids and becomes available with a revision', async () => {
    // The stub embeds distinct texts to distinct near-orthogonal unit vectors,
    // so the 30 high vs 30 low anchors form separated centroids.
    const svc = new SemanticClassifierService(fakeRuntime(stubEmbedder(384)));
    await svc.onApplicationBootstrap();
    expect(svc.available).toBe(true);
    const state = await svc.resolve({ kind: 'user', userId: 'u' }, DISABLED_LEARNING_GATE);
    expect(state.source).toBe('bundled');
    expect(state.revision).toMatch(/^sha256:/);
    expect(state.centroids.high).toHaveLength(384);
  });

  it('a degenerate embedder (all anchors → the same vector) FAILS OPEN — unavailable, no throw (clink r1 High-4 refinement)', async () => {
    const collapse: Embedder = {
      id: 'sha256:degenerate',
      dims: 8,
      embed: () => {
        const v = new Float32Array(8);
        v[0] = 1; // every text → e_0 → high and low centroids identical → cancel
        return Promise.resolve(v);
      },
    };
    const svc = new SemanticClassifierService(fakeRuntime(collapse));
    // Must NOT throw — degrades to unavailable (invariant 1), never crashes boot.
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(svc.available).toBe(false);
  });
});

describe('SemanticClassifierService — the semantic WORKLOAD source (add-semantic-workloads D4)', () => {
  it('builds five validated workload centroids with a semantic revision when the band build succeeds', async () => {
    const svc = new SemanticClassifierService(fakeRuntime(stubEmbedder(384)));
    await svc.onApplicationBootstrap();
    expect(svc.available).toBe(true);
    expect(svc.workloadReady).toBe(true);
    const wl = svc.workloadState!;
    expect(Object.keys(wl.centroids).sort()).toEqual([
      'code',
      'research',
      'structured',
      'vision',
      'writing',
    ]);
    for (const v of Object.values(wl.centroids)) expect(v).toHaveLength(384);
    expect(wl.rails).toEqual({ margin: 0.05, minSim: 0.2 });
    expect(wl.revision).toMatch(/^semantic\/v1\/s1\/[0-9a-f]{12}$/);
  });

  it('module absent: no workload source either', async () => {
    const svc = new SemanticClassifierService(fakeRuntime(null));
    await svc.onApplicationBootstrap();
    expect(svc.workloadReady).toBe(false);
    expect(svc.workloadState).toBeNull();
  });

  it('a degenerate embedder leaves BOTH sources unavailable without throwing', async () => {
    const collapse: Embedder = {
      id: 'sha256:degenerate',
      dims: 8,
      embed: () => {
        const v = new Float32Array(8);
        v[0] = 1;
        return Promise.resolve(v);
      },
    };
    const svc = new SemanticClassifierService(fakeRuntime(collapse));
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(svc.available).toBe(false);
    expect(svc.workloadReady).toBe(false);
  });

  it('a failure while embedding ONE workload anchor disables only the workload source — the band classifier stays available (separate boundary)', async () => {
    const base = stubEmbedder(384);
    const throwing: Embedder = {
      id: base.id,
      dims: base.dims,
      embed: (text, opts) =>
        text.includes('intermittent fasting and longevity') // a research workload anchor; no band anchor contains it
          ? Promise.reject(new Error('injected workload-anchor fault'))
          : base.embed(text, opts),
    };
    const svc = new SemanticClassifierService(fakeRuntime(throwing));
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(svc.available).toBe(true);
    expect(svc.workloadReady).toBe(false);
    expect(svc.workloadState).toBeNull();
  });
});
