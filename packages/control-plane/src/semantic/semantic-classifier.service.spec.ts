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
