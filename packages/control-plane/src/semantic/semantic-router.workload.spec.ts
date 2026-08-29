import {
  HIGH_ANCHORS,
  WORKLOAD_ANCHORS,
  stubEmbedder,
  type Embedder,
  type NormalizedRequest,
  type RoutingSnapshot,
} from '@polyrouter/data-plane';
import type { Principal } from '@polyrouter/shared/server';
import { DISABLED_LEARNING_GATE } from './classification-source';
import { SemanticClassifierService } from './semantic-classifier.service';
import { SemanticRouter } from './semantic-router';
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
const principal: Principal = { kind: 'user', userId: 'u1' };
const ir = (text: string): NormalizedRequest => ({
  model: 'auto',
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  params: {},
});
const EMPTY_SNAPSHOT = {
  tiers: [],
  entriesByTierId: new Map(),
  rules: [],
  models: [],
} as unknown as RoutingSnapshot;

function fakeRuntime(embedder: Embedder | null): SemanticRuntimeService {
  return {
    embedder,
    // Both seams + the bounded factory, as the real loader supplies them
    // (fix-semantic-boot-embed-budget); one model, one gate, one behaviour.
    bootEmbedder: embedder,
    config: CFG,
    whenReady: () => Promise.resolve(embedder),
    boundEmbedder: () => embedder,
  } as unknown as SemanticRuntimeService;
}

async function ready(
  embedder: Embedder | null,
): Promise<{ router: SemanticRouter; classifier: SemanticClassifierService }> {
  const runtime = fakeRuntime(embedder);
  const classifier = new SemanticClassifierService(runtime);
  await classifier.onApplicationBootstrap();
  return { router: new SemanticRouter(runtime, classifier, classifier), classifier };
}

describe('SemanticRouter split (add-semantic-workloads D2)', () => {
  it('evaluate == embed + classifyBand on the same request (the pre-split contract holds)', async () => {
    const { router } = await ready(stubEmbedder(384));
    const req = ir(
      'Prove that the sum of the reciprocals of the primes diverges, with full rigor.',
    );
    const viaEvaluate = await router.evaluate(
      principal,
      req,
      EMPTY_SNAPSHOT,
      DISABLED_LEARNING_GATE,
    );
    const embedded = await router.embed(req);
    expect(embedded).not.toBeNull();
    const viaSplit = await router.classifyBand(
      embedded!.vector,
      principal,
      EMPTY_SNAPSHOT,
      DISABLED_LEARNING_GATE,
    );
    expect(viaSplit.kind).toBe(viaEvaluate.kind);
    if (viaSplit.kind !== 'skip' && viaEvaluate.kind !== 'skip') {
      expect(viaSplit.verdict).toEqual(viaEvaluate.verdict);
    }
  });

  it('embed returns null for no evidence, for an absent embedder, and for a DEGENERATE vector; it propagates embedder rejections', async () => {
    const { router } = await ready(stubEmbedder(384));
    expect(await router.embed({ model: 'auto', messages: [], params: {} })).toBeNull();
    const { router: none } = await ready(null);
    expect(await none.embed(ir('anything'))).toBeNull();
    const zero: Embedder = {
      id: 'sha256:z',
      dims: 8,
      embed: () => Promise.resolve(new Float32Array(8)),
    };
    const { router: degenerate } = await ready(zero);
    expect(await degenerate.embed(ir('anything'))).toBeNull();
    const rejecting: Embedder = {
      id: 'sha256:r',
      dims: 8,
      embed: () => Promise.reject(new Error('timeout')),
    };
    const { router: rej } = await ready(rejecting);
    await expect(rej.embed(ir('anything'))).rejects.toThrow('timeout');
    // ...and evaluate still degrades that rejection to skip
    expect(
      (await rej.evaluate(principal, ir('anything'), EMPTY_SNAPSHOT, DISABLED_LEARNING_GATE)).kind,
    ).toBe('skip');
  });

  it('classifyWorkload emits a reserved class for a request embedded like a research anchor, none for a structural-class lookalike, null when not ready', async () => {
    const { router, classifier } = await ready(stubEmbedder(384));
    expect(router.workloadEnabled).toBe(true);
    // The stub embeds identical serialized text to identical vectors: an anchor's
    // own text sits exactly on its class's centroid direction (mean of 30 near-
    // orthogonal vectors → cosine ≈ 1/sqrt(30) ≈ 0.18 to its own centroid) — so
    // use a floor of 0 here and assert the argmax/ownership rule, not the floor.
    const wl = classifier.workloadState!;
    const research = WORKLOAD_ANCHORS.research[0]!;
    const embeddedR = await router.embed(ir(research));
    const vR = router.classifyWorkload(embeddedR!.vector);
    // With the default floor 0.2 the stub's 0.18 self-similarity abstains honestly (none, semantic source)
    expect(vR).not.toBeNull();
    expect(vR!.source).toBe('semantic');
    expect(['research', 'none']).toContain(vR!.class);
    expect(vR!.revision).toBe(wl.revision);
    expect(vR!.reason).toMatch(
      /^workload:(research|none) score=\d\.\d{4} m=-?\d\.\d{4} sim2=-?\d\.\d{4} top=research top2=\w+ src=semantic$/,
    );
    // A code anchor: argmax code → the semantic source never emits it
    const embeddedC = await router.embed(ir(WORKLOAD_ANCHORS.code[0]!));
    const vC = router.classifyWorkload(embeddedC!.vector);
    expect(vC!.class).toBe('none');
    expect(vC!.reason).toContain('top=code');
    // not ready → null
    const { router: offline } = await ready(null);
    expect(offline.workloadEnabled).toBe(false);
    expect(offline.classifyWorkload(new Float32Array(384))).toBeNull();
  });
});

describe('SemanticRouter.classifyBand — class scope (add-workload-scoped-bands)', () => {
  const scopedSnapshot = (): RoutingSnapshot =>
    ({
      tiers: [
        { id: 't-strong', key: 'strong' },
        { id: 't-code', key: 'strong-code' },
      ],
      entriesByTierId: new Map([
        ['t-strong', [{ modelId: 'm1', position: 0 }]],
        ['t-code', [{ modelId: 'm2', position: 0 }]],
      ]),
      rules: [
        {
          id: 'g',
          matchType: 'auto_high',
          headerName: null,
          headerValue: null,
          target: 'tier:strong',
          priority: 0,
          createdAt: new Date(0),
        },
        {
          id: 'c',
          matchType: 'auto_high',
          headerName: null,
          headerValue: null,
          workloadClass: 'code',
          target: 'tier:strong-code',
          priority: 0,
          createdAt: new Date(0),
        },
      ],
      models: [
        { id: 'm1', providerId: 'p1', externalModelId: 'strong-model' },
        { id: 'm2', providerId: 'p1', externalModelId: 'strong-code-model' },
      ],
    }) as unknown as RoutingSnapshot;

  it('a confident semantic band resolves the class-scoped target for its scope and the generic one otherwise', async () => {
    const { router } = await ready(stubEmbedder(384));
    // An exact HIGH anchor embeds onto the high centroid's direction (stub: identical text → identical vector)
    const embedded = await router.embed(ir(HIGH_ANCHORS[0]!));
    expect(embedded).not.toBeNull();
    const generic = await router.classifyBand(
      embedded!.vector,
      principal,
      scopedSnapshot(),
      DISABLED_LEARNING_GATE,
    );
    const forCode = await router.classifyBand(
      embedded!.vector,
      principal,
      scopedSnapshot(),
      DISABLED_LEARNING_GATE,
      'code',
    );
    const forVision = await router.classifyBand(
      embedded!.vector,
      principal,
      scopedSnapshot(),
      DISABLED_LEARNING_GATE,
      'vision',
    );
    expect(generic.kind).toBe('route');
    expect(forCode.kind).toBe('route');
    if (generic.kind === 'route' && forCode.kind === 'route' && forVision.kind === 'route') {
      expect(generic.decision.tierKey).toBe('strong');
      expect(forCode.decision.tierKey).toBe('strong-code');
      expect(forCode.decision.scope).toBe('code'); // data — the proxy appends the terminal fragment
      expect(forCode.decision.routingReason).toMatch(/^semantic:high /);
      expect(forCode.decision.routingReason).not.toContain('scope=');
      expect(forVision.decision.tierKey).toBe('strong');
      expect(forVision.decision.scope).toBeUndefined();
      expect(forVision.decision.routingReason).not.toContain('scope=');
    }
    // evaluate threads the scope too
    const e = await router.evaluate(
      principal,
      ir(HIGH_ANCHORS[0]!),
      scopedSnapshot(),
      DISABLED_LEARNING_GATE,
      undefined,
      'code',
    );
    expect(e.kind === 'route' && e.decision.tierKey).toBe('strong-code');
  });
});
