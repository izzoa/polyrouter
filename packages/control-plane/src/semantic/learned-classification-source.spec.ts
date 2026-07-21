import type { Principal } from '@polyrouter/shared/server';
import type { ClassificationState, LearningGate } from './classification-source';
import { deriveTenantHmacKey, tenantHmac } from './learning-format';
import { LearnedClassificationSource } from './learned-classification-source';
import type { SemanticClassifierService } from './semantic-classifier.service';
import { InMemoryLearningStore } from './testing/in-memory-learning-store';

/**
 * The learned-supersedes-bundled decorator (add-semantic-learning D4): learned
 * ONLY under a passing gate, BUNDLED on every failure, never skip.
 */

const dims = 8;
const unit = (hot: number): Float32Array => {
  const v = new Float32Array(dims);
  v[hot] = 1;
  return v;
};
const BUNDLED: ClassificationState = {
  centroids: { high: unit(0), low: unit(1) },
  source: 'bundled',
  revision: 'sha256:bundled',
};
const LEARNED = { high: unit(2), low: unit(3) };
const principal: Principal = { kind: 'user', userId: 'u1' };
const REV = 'sha256:ev1';
const gate = (over: Partial<LearningGate> = {}): LearningGate => ({
  enabled: true,
  epoch: 0,
  generation: 1,
  evidenceRevision: REV,
  ...over,
});
const KEY = deriveTenantHmacKey('secret');
const HMAC = tenantHmac(KEY, 'u1');

function fakeClassifier(bundled: ClassificationState | null): SemanticClassifierService {
  return {
    bundledState: () => bundled,
    learnedRevision: (e: number, g: number) => `sha256:learned:${String(e)}.${String(g)}`,
  } as unknown as SemanticClassifierService;
}

function make(store: InMemoryLearningStore, bundled: ClassificationState | null = BUNDLED) {
  return new LearnedClassificationSource(store, KEY, fakeClassifier(bundled), 50);
}

describe('LearnedClassificationSource', () => {
  it('returns BUNDLED when the gate is disabled', async () => {
    const store = new InMemoryLearningStore();
    const state = await make(store).resolve(principal, gate({ enabled: false }));
    expect(state.source).toBe('bundled');
  });

  it('supersedes with LEARNED when active state matches the gate', async () => {
    const store = new InMemoryLearningStore();
    await store.stage(
      HMAC,
      'occ',
      { epoch: 0, generation: 1, revision: REV, centroids: LEARNED },
      3600,
    );
    await store.promote(HMAC, 'occ', { epoch: 0, generation: 1 }, 3600);

    const state = await make(store).resolve(principal, gate());
    expect(state.source).toBe('learned');
    expect(Array.from(state.centroids.high)).toEqual(Array.from(LEARNED.high));
    expect(state.revision).toBe('sha256:learned:0.1');
  });

  it('falls back to BUNDLED when no learned state exists', async () => {
    const store = new InMemoryLearningStore();
    const state = await make(store).resolve(principal, gate());
    expect(state.source).toBe('bundled');
  });

  it('falls back to BUNDLED on a gate coordinate mismatch (stale generation)', async () => {
    const store = new InMemoryLearningStore();
    await store.stage(
      HMAC,
      'occ',
      { epoch: 0, generation: 1, revision: REV, centroids: LEARNED },
      3600,
    );
    await store.promote(HMAC, 'occ', { epoch: 0, generation: 1 }, 3600);
    // The request was decided under generation 2 — the learned state at 1 is stale.
    const state = await make(store).resolve(principal, gate({ generation: 2 }));
    expect(state.source).toBe('bundled');
  });

  it('falls back to BUNDLED when the loaded centroids fail validation', async () => {
    const store = new InMemoryLearningStore();
    // Degenerate learned state: high == low → validateCentroids throws (cancelling).
    const bad = { high: unit(0), low: unit(0) };
    await store.stage(
      HMAC,
      'occ',
      { epoch: 0, generation: 1, revision: REV, centroids: bad },
      3600,
    );
    await store.promote(HMAC, 'occ', { epoch: 0, generation: 1 }, 3600);
    const state = await make(store).resolve(principal, gate());
    expect(state.source).toBe('bundled');
  });

  it('falls back to BUNDLED (never throws) on a store fault', async () => {
    const faultingStore = {
      readActive: () => Promise.reject(new Error('redis down')),
    } as unknown as InMemoryLearningStore;
    const state = await make(faultingStore).resolve(principal, gate());
    expect(state.source).toBe('bundled');
  });

  it('caches a learned read (second resolve does not re-hit the store)', async () => {
    const store = new InMemoryLearningStore();
    await store.stage(
      HMAC,
      'occ',
      { epoch: 0, generation: 1, revision: REV, centroids: LEARNED },
      3600,
    );
    await store.promote(HMAC, 'occ', { epoch: 0, generation: 1 }, 3600);
    let reads = 0;
    const orig = store.readActive.bind(store);
    store.readActive = (h, g) => {
      reads += 1;
      return orig(h, g);
    };
    const src = make(store);
    await src.resolve(principal, gate());
    await src.resolve(principal, gate());
    expect(reads).toBe(1); // second served from the LRU
  });

  it('re-validates a cached entry past its TTL against Redis (clink impl High-2)', async () => {
    const store = new InMemoryLearningStore();
    await store.stage(
      HMAC,
      'occ',
      { epoch: 0, generation: 1, revision: REV, centroids: LEARNED },
      3600,
    );
    await store.promote(HMAC, 'occ', { epoch: 0, generation: 1 }, 3600);
    let clock = 1_000;
    const src = new LearnedClassificationSource(
      store,
      KEY,
      fakeClassifier(BUNDLED),
      50,
      () => {},
      () => clock,
    );
    expect((await src.resolve(principal, gate())).source).toBe('learned'); // caches

    await store.deleteTenant(HMAC); // the active key expires in Redis (dormant tenant)
    clock += 30_000;
    expect((await src.resolve(principal, gate())).source).toBe('learned'); // within cache window
    clock += 61_000;
    expect((await src.resolve(principal, gate())).source).toBe('bundled'); // re-read → gone → bundled
  });
});
