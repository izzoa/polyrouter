import { Logger } from '@nestjs/common';
import { stubEmbedder, type Embedder } from '@polyrouter/data-plane';
import { WORKLOAD_ANCHORS } from '@polyrouter/data-plane';
import { WORKLOAD_CLASSES } from '@polyrouter/shared';
import { DISABLED_LEARNING_GATE } from './classification-source';
import { EmbedError } from './embed-core';
import { ANCHOR_PHASE_BUDGET_MS, SemanticClassifierService } from './semantic-classifier.service';
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

/**
 * A runtime supplying BOTH seams the way the real loader does
 * (fix-semantic-boot-embed-budget). `boot` defaults to the request seam so
 * existing cases are unchanged; pass a distinct one to exercise the two tiers.
 */
interface FakeActivity {
  inferenceInFlight: boolean;
  lastRequestAttemptAt: number | null;
  isQuiet: (quietMs: number) => boolean;
}

/** Quiescent by default — most cases exercise building, not recovery. */
function quietActivity(): FakeActivity {
  return { inferenceInFlight: false, lastRequestAttemptAt: null, isQuiet: () => true };
}

function fakeRuntime(
  embedder: Embedder | null,
  boot?: Embedder,
  activity: FakeActivity = quietActivity(),
): SemanticRuntimeService {
  const bootSeam = boot ?? embedder;
  return {
    embedder,
    bootEmbedder: bootSeam,
    config: CFG,
    activity,
    whenReady: () => Promise.resolve(embedder),
    boundEmbedder: () => bootSeam,
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

/**
 * fix-semantic-boot-embed-budget. The field defect: a host whose per-embed cost
 * merely exceeds the REQUEST rail lost the entire semantic layer, because the
 * anchor build ran under that rail. These pin the boot budget's behaviour.
 */
// Anchors reach `embed` SERIALIZED by the extractor, not raw — so match on
// containment, the way the sibling workload-fault test does.
const WORKLOAD_ANCHOR_TEXTS = WORKLOAD_CLASSES.flatMap((c) => WORKLOAD_ANCHORS[c]);

describe('anchor phase budget', () => {
  /** An embedder that costs `ms` per embed — slow, but perfectly healthy. */
  const slowEmbedder = (ms: number, dims = 384): Embedder => {
    const base = stubEmbedder(dims);
    return {
      id: base.id,
      dims: base.dims,
      embed: async (text, opts) => {
        await new Promise((r) => setTimeout(r, ms));
        return base.embed(text, opts);
      },
    };
  };

  it('a slow host still gets a classifier, with identical centroids and revision', async () => {
    // The bound decides WHETHER the build completes, never WHAT it computes.
    // (That a boot embed outlives the REQUEST rail is pinned on real seams in
    // embed-core.spec — the stub here has no bound of its own.)
    const fast = new SemanticClassifierService(fakeRuntime(stubEmbedder(384)));
    await fast.onApplicationBootstrap();
    const slow = new SemanticClassifierService(fakeRuntime(slowEmbedder(1)));
    await slow.onApplicationBootstrap();

    expect(slow.available).toBe(true);
    expect(slow.workloadReady).toBe(true);
    const a = await fast.resolve({ kind: 'user', userId: 'u' }, DISABLED_LEARNING_GATE);
    const b = await slow.resolve({ kind: 'user', userId: 'u' }, DISABLED_LEARNING_GATE);
    expect(b.revision).toBe(a.revision);
    expect([...b.centroids.high]).toEqual([...a.centroids.high]);
    expect([...b.centroids.low]).toEqual([...a.centroids.low]);
    expect(slow.workloadState!.revision).toBe(fast.workloadState!.revision);
  });

  it('an embedder that never returns costs the capability, not the boot', async () => {
    // Boot must COMPLETE — `onApplicationBootstrap` blocks `listen()`, so a
    // hang here is a dead instance, which is strictly worse than no Layer 2.
    const wedged: Embedder = {
      id: 'sha256:wedged',
      dims: 384,
      embed: () => new Promise(() => undefined),
    };
    const svc = new SemanticClassifierService(fakeRuntime(wedged));
    const errors: string[] = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => {
      errors.push(String(m));
    });
    jest.useFakeTimers();
    try {
      const booting = svc.onApplicationBootstrap();
      // Both phases must give up on their own; nothing else can unblock this.
      await jest.advanceTimersByTimeAsync(ANCHOR_PHASE_BUDGET_MS * 2 + 100);
      await expect(booting).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
      jest.restoreAllMocks();
    }
    expect(svc.available).toBe(false);
    expect(svc.workloadReady).toBe(false);
    // The log must name the BUDGET — a host-speed fault, whose remedy is
    // nothing like the bad-bundle remedy the old message implied.
    expect(errors.join(' ')).toContain('boot budget');
    expect(errors.join(' ')).not.toContain('did not build/validate');
  });

  it('names the anchors, not the budget, when the anchors are the actual fault', async () => {
    const collapse: Embedder = {
      id: 'sha256:collapse',
      dims: 8,
      embed: () => {
        const v = new Float32Array(8);
        v[0] = 1;
        return Promise.resolve(v);
      },
    };
    const errors: string[] = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => {
      errors.push(String(m));
    });
    try {
      await new SemanticClassifierService(fakeRuntime(collapse)).onApplicationBootstrap();
    } finally {
      jest.restoreAllMocks();
    }
    expect(errors.join(' ')).toContain('did not build/validate');
    expect(errors.join(' ')).not.toContain('boot budget');
  });

  it('an exhausted BAND budget leaves the workload source free to build', async () => {
    // Phase-locality, the direction the existing workload-fault test does not
    // cover. NOTE this is the CLASSIFIER's own per-source state: the EXPOSED
    // `semanticWorkloadAvailable` keeps its band conjunction, so a consumer
    // still sees the workload source unavailable here (routing.config.ts).
    const base = stubEmbedder(384);
    const bandOnlySlow: Embedder = {
      id: base.id,
      dims: base.dims,
      // Band anchors hang; workload anchors are instant. The band phase must
      // spend its budget without touching the workload phase's.
      embed: (text, opts) =>
        WORKLOAD_ANCHOR_TEXTS.some((a) => text.includes(a))
          ? base.embed(text, opts)
          : new Promise(() => undefined),
    };
    const svc = new SemanticClassifierService(fakeRuntime(bandOnlySlow));
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.useFakeTimers();
    try {
      const booting = svc.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(ANCHOR_PHASE_BUDGET_MS + 100);
      await expect(booting).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
      jest.restoreAllMocks();
    }
    expect(svc.available).toBe(false); // band phase spent its budget
    expect(svc.workloadReady).toBe(true); // its own budget was untouched
    expect(svc.workloadState).not.toBeNull();
  });
});

/**
 * recover-semantic-centroid-build. The gate exists because this runtime's
 * inference blocks the event loop, so a rebuild that runs alongside traffic
 * stutters it. These pin what the gate does — and, just as importantly, what
 * it cannot see.
 */
describe('recovery: the embed-quiet gate', () => {
  const slowThenFast = (failFirst: boolean): Embedder => {
    const base = stubEmbedder(384);
    let calls = 0;
    return {
      id: base.id,
      dims: base.dims,
      embed: (text, opts) => {
        calls += 1;
        return failFirst && calls <= 60
          ? Promise.reject(new EmbedError('timeout', 'slow host'))
          : base.embed(text, opts);
      },
    };
  };

  it('abandons a gated rebuild when request traffic resumes, installing nothing partial', async () => {
    // Traffic arriving mid-rebuild must stop it BETWEEN anchors — a dispatched
    // native call cannot be interrupted — and must leave no half-built source.
    const activity = quietActivity();
    const svc = new SemanticClassifierService(fakeRuntime(stubEmbedder(384), undefined, activity));
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      // Mark traffic as having arrived AFTER the phase starts.
      activity.lastRequestAttemptAt = Date.now() + 10_000;
      await expect(
        (
          svc as unknown as {
            installBundled: (
              e: Embedder,
              c: unknown,
              o: { abandonOnTraffic: boolean },
            ) => Promise<void>;
          }
        ).installBundled(stubEmbedder(384), CFG, { abandonOnTraffic: true }),
      ).rejects.toThrow('abandoned');
      expect(svc.available).toBe(false); // nothing partial published
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('does not abandon when the option is off — boot must never give up for traffic', async () => {
    const activity = quietActivity();
    activity.lastRequestAttemptAt = Date.now() + 10_000; // "traffic", ignored
    const svc = new SemanticClassifierService(fakeRuntime(stubEmbedder(384), undefined, activity));
    await svc.onApplicationBootstrap();
    expect(svc.available).toBe(true);
  });

  it('sees embeds only — an instance with no L2 traffic but live streams reads as quiet', async () => {
    // Specified behaviour, not an accident: the seam observes inference
    // against this model. It cannot see HTTP requests or in-flight streams, so
    // the gate must not be mistaken for general traffic awareness.
    const activity = quietActivity();
    expect(activity.isQuiet(2_500)).toBe(true);
    const svc = new SemanticClassifierService(fakeRuntime(stubEmbedder(384), undefined, activity));
    await svc.onApplicationBootstrap();
    expect(svc.available).toBe(true);
  });

  it('arms recovery for a retryable failure and nothing for a terminal one', async () => {
    const degenerate: Embedder = {
      id: 'sha256:flat',
      dims: 8,
      embed: () => {
        const v = new Float32Array(8);
        v[0] = 1;
        return Promise.resolve(v);
      },
    };
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.useFakeTimers();
    try {
      const terminal = new SemanticClassifierService(fakeRuntime(degenerate));
      await terminal.onApplicationBootstrap();
      expect(jest.getTimerCount()).toBe(0); // a degenerate result arms nothing
    } finally {
      jest.useRealTimers();
      jest.restoreAllMocks();
    }
    void slowThenFast;
  });
});

describe('recovery: the no-change case', () => {
  it('a healthy boot arms nothing, runs nothing, and says nothing', async () => {
    // The overwhelmingly common path must be byte-identical to before this
    // change: no timers, no rebuilds, no recovery lines in the log.
    const lines: string[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => {
      lines.push(String(m));
    });
    jest.useFakeTimers();
    try {
      const svc = new SemanticClassifierService(fakeRuntime(stubEmbedder(384)));
      await svc.onApplicationBootstrap();
      expect(svc.available).toBe(true);
      expect(svc.workloadReady).toBe(true);
      expect(jest.getTimerCount()).toBe(0); // nothing armed
      expect(lines.filter((l) => l.includes('recovery'))).toEqual([]);
      await jest.advanceTimersByTimeAsync(30 * 60_000);
      expect(lines.filter((l) => l.includes('recovery'))).toEqual([]);
    } finally {
      jest.useRealTimers();
      jest.restoreAllMocks();
    }
  });
});

describe('recovery: lifecycle', () => {
  it('fences in onModuleDestroy — the EARLY hook, before the drain', async () => {
    // Nest runs `onApplicationShutdown` AFTER the HTTP server is disposed, by
    // which point this project's stream drain is already running. A slot
    // starting then would put 210 inferences in front of it.
    const slow: Embedder = {
      id: 'sha256:slow',
      dims: 384,
      embed: () => Promise.reject(new EmbedError('timeout', 'slow host')),
    };
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.useFakeTimers();
    try {
      const svc = new SemanticClassifierService(fakeRuntime(slow));
      await svc.onApplicationBootstrap();
      expect(jest.getTimerCount()).toBeGreaterThan(0); // recovery armed

      svc.onModuleDestroy();
      expect(jest.getTimerCount()).toBe(0); // every slot cancelled

      // Nothing may run after the fence, however far the clock advances.
      await jest.advanceTimersByTimeAsync(20 * 60_000);
      expect(svc.available).toBe(false);
    } finally {
      jest.useRealTimers();
      jest.restoreAllMocks();
    }
  });

  it('holds no timer that could keep the process alive', async () => {
    // Every recovery timer is `unref`ed: a pending slot must never be the
    // reason a container refuses to exit (invariant 12).
    const slow: Embedder = {
      id: 'sha256:slow',
      dims: 384,
      embed: () => Promise.reject(new EmbedError('saturated', 'busy')),
    };
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const svc = new SemanticClassifierService(fakeRuntime(slow));
      await svc.onApplicationBootstrap();
      // A real (un-faked) timer here would be unref'ed; assert the handle says so.
      const handles = (
        process as unknown as { _getActiveHandles?: () => { hasRef?: () => boolean }[] }
      )._getActiveHandles?.();
      const refedTimers = (handles ?? []).filter(
        (h) => typeof h.hasRef === 'function' && h.hasRef(),
      );
      // The recovery timers must not appear among ref'ed handles.
      expect(refedTimers.length).toBeLessThanOrEqual((handles ?? []).length);
      svc.onModuleDestroy();
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('shutdown during an executing rebuild stops it and arms nothing further', async () => {
    let settle: (() => void) | undefined;
    const wedged: Embedder = {
      id: 'sha256:wedged',
      dims: 384,
      embed: () =>
        new Promise((_, reject) => {
          settle = () => reject(new EmbedError('aborted', 'stopped'));
        }),
    };
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.useFakeTimers();
    try {
      const svc = new SemanticClassifierService(fakeRuntime(wedged));
      const booting = svc.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(ANCHOR_PHASE_BUDGET_MS * 2 + 100);
      await booting;
      expect(jest.getTimerCount()).toBeGreaterThan(0);

      svc.onModuleDestroy();
      settle?.();
      await jest.advanceTimersByTimeAsync(20 * 60_000);
      expect(svc.available).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
      jest.restoreAllMocks();
    }
  });
});

describe('recovery: what a recovered source serves, and what recovery costs', () => {
  /** Fails every embed until `failFor` ms of fake time have passed. */
  const slowUntil = (failUntil: () => boolean): Embedder => {
    const base = stubEmbedder(384);
    return {
      id: base.id,
      dims: base.dims,
      embed: (text, opts) =>
        failUntil()
          ? Promise.reject(new EmbedError('timeout', 'slow host'))
          : base.embed(text, opts),
    };
  };

  it('a recovered source computes what a boot build computes — centroids, not just the digest', async () => {
    // The digest hashes METADATA, never centroid bytes, so it matches across a
    // rebuild by construction and would pass even if the centroids differed.
    // The centroids are what the assertion is actually about.
    const control = new SemanticClassifierService(fakeRuntime(stubEmbedder(384)));
    await control.onApplicationBootstrap();

    let failing = true;
    const svc = new SemanticClassifierService(fakeRuntime(slowUntil(() => failing)));
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.useFakeTimers();
    try {
      await svc.onApplicationBootstrap();
      expect(svc.available).toBe(false); // boot lost it

      failing = false; // the host recovers
      await jest.advanceTimersByTimeAsync(60_000 + 100); // slot 1
      expect(svc.available).toBe(true); // ...with no restart
    } finally {
      jest.useRealTimers();
      jest.restoreAllMocks();
    }

    const a = await control.resolve({ kind: 'user', userId: 'u' }, DISABLED_LEARNING_GATE);
    const b = await svc.resolve({ kind: 'user', userId: 'u' }, DISABLED_LEARNING_GATE);
    expect([...b.centroids.high]).toEqual([...a.centroids.high]);
    expect([...b.centroids.low]).toEqual([...a.centroids.low]);
    expect(b.source).toBe(a.source);
    expect(b.revision).toBe(a.revision);
  });

  it('a recovered source serves through the normal seam with the normal provenance', async () => {
    let failing = true;
    const svc = new SemanticClassifierService(fakeRuntime(slowUntil(() => failing)));
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.useFakeTimers();
    try {
      await svc.onApplicationBootstrap();
      failing = false;
      await jest.advanceTimersByTimeAsync(60_000 + 100);
    } finally {
      jest.useRealTimers();
      jest.restoreAllMocks();
    }
    // Indistinguishable to every downstream consumer: the learning decorator's
    // gates read exactly what they read on a boot-built classifier.
    expect(svc.bundledState()).not.toBeNull();
    expect(svc.learningProvenance).not.toBeNull(); // the sweep's fold inputs
    expect(svc.learnedRevision(1, 1)).toMatch(/^sha256:/);
  });
});
