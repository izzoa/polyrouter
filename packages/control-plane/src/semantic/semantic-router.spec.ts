import {
  extractSemanticInput,
  stubEmbedder,
  type Embedder,
  type NormalizedRequest,
  type RoutingSnapshot,
} from '@polyrouter/data-plane';
import type { Principal } from '@polyrouter/shared/server';
import { DISABLED_LEARNING_GATE, type ClassificationState } from './classification-source';
import { SemanticClassifierService } from './semantic-classifier.service';
import { SemanticRouter } from './semantic-router';
import { SemanticRuntimeService } from './semantic-runtime.service';

const principal: Principal = { kind: 'user', userId: 'u1' };
const GATE = DISABLED_LEARNING_GATE;
const ir = (text: string): NormalizedRequest => ({
  model: 'auto',
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  params: {},
});

/** A snapshot whose auto_high/auto_low rules resolve to a tier (or not). */
const snapshot = (withTargets: boolean): RoutingSnapshot =>
  ({
    tiers: withTargets
      ? [
          { id: 't-strong', key: 'strong' },
          { id: 't-cheap', key: 'cheap' },
        ]
      : [],
    entriesByTierId: new Map(
      withTargets
        ? [
            ['t-strong', [{ modelId: 'm1', position: 0 }]],
            ['t-cheap', [{ modelId: 'm2', position: 0 }]],
          ]
        : [],
    ),
    rules: withTargets
      ? [
          {
            id: 'r-high',
            matchType: 'auto_high',
            headerName: null,
            headerValue: null,
            target: 'tier:strong',
            priority: 0,
            createdAt: new Date(0),
          },
          {
            id: 'r-low',
            matchType: 'auto_low',
            headerName: null,
            headerValue: null,
            target: 'tier:cheap',
            priority: 0,
            createdAt: new Date(0),
          },
        ]
      : [],
    models: withTargets
      ? [
          { id: 'm1', providerId: 'p1', externalModelId: 'strong-model' },
          { id: 'm2', providerId: 'p1', externalModelId: 'cheap-model' },
        ]
      : [],
  }) as unknown as RoutingSnapshot;

function fakeRuntime(
  embedder: Embedder | null,
  over?: { highThreshold?: number; lowThreshold?: number },
): SemanticRuntimeService {
  return {
    embedder,
    config: {
      modelPath: embedder ? '/x' : undefined,
      timeoutMs: 50,
      maxInputChars: 2000,
      concurrency: 2,
      highThreshold: over?.highThreshold ?? 0.15,
      lowThreshold: over?.lowThreshold ?? 0.15,
    },
  } as unknown as SemanticRuntimeService;
}

function fakeClassifier(state: ClassificationState | null): SemanticClassifierService {
  return {
    available: state !== null,
    // Doubles as both the classifier (`available`) and the classification SOURCE
    // (`resolve`) constructor args; the base source is always the given state.
    resolve: () =>
      state === null ? Promise.reject(new Error('not ready')) : Promise.resolve(state),
  } as unknown as SemanticClassifierService;
}

const embedder = stubEmbedder(64);

describe('SemanticRouter.evaluate', () => {
  let highVec: Float32Array;
  let lowVec: Float32Array;
  let state: ClassificationState;

  const HIGH_TEXT = 'prove the theorem rigorously with full derivation';
  const LOW_TEXT = 'what time is it in tokyo';
  // Centroids are built through the SAME extractor the router uses, so a
  // request equal to an anchor lands squarely in that band (the stub hashes
  // the serialized text, `user: …` framing included).
  const serialized = (text: string): string => extractSemanticInput(ir(text), { totalChars: 2000 });

  beforeAll(async () => {
    highVec = await embedder.embed(serialized(HIGH_TEXT));
    lowVec = await embedder.embed(serialized(LOW_TEXT));
    state = {
      centroids: { high: highVec, low: lowVec },
      source: 'bundled',
      revision: 'sha256:rev',
    };
  });

  it('skips when the classifier is not ready', async () => {
    const r = new SemanticRouter(fakeRuntime(embedder), fakeClassifier(null), fakeClassifier(null));
    expect(await r.evaluate(principal, ir('x'), snapshot(true), GATE)).toEqual({ kind: 'skip' });
  });

  it('routes a confident-high request to auto_high with decision_layer=semantic', async () => {
    const r = new SemanticRouter(
      fakeRuntime(embedder),
      fakeClassifier(state),
      fakeClassifier(state),
    );
    const res = await r.evaluate(principal, ir(HIGH_TEXT), snapshot(true), GATE);
    expect(res.kind).toBe('route');
    if (res.kind === 'route') {
      expect(res.decision.decisionLayer).toBe('semantic');
      expect(res.verdict.band).toBe('high');
      expect(res.verdict.source).toBe('bundled');
      expect(res.verdict.reason).toMatch(/^semantic:high s=/);
    }
  });

  it('is unroutable (verdict kept) when the confident band has no target', async () => {
    const r = new SemanticRouter(
      fakeRuntime(embedder),
      fakeClassifier(state),
      fakeClassifier(state),
    );
    const res = await r.evaluate(principal, ir(HIGH_TEXT), snapshot(false), GATE);
    expect(res.kind).toBe('unroutable');
    if (res.kind === 'unroutable') expect(res.verdict.band).toBe('high');
  });

  it('returns ambiguous for a middling request', async () => {
    // A text near neither centroid → score in the wide ambiguous band.
    const r = new SemanticRouter(
      fakeRuntime(embedder, { highThreshold: 0.9, lowThreshold: 0.9 }),
      fakeClassifier(state),
      fakeClassifier(state),
    );
    const res = await r.evaluate(
      principal,
      ir('some unrelated neutral text here'),
      snapshot(true),
      GATE,
    );
    expect(res.kind).toBe('ambiguous');
  });

  it('skips a request with NO non-system evidence WITHOUT embedding (clink r2 Med-2)', async () => {
    let embedCalls = 0;
    const spy = {
      id: 'x',
      dims: 64,
      embed: (t: string) => {
        embedCalls += 1;
        return embedder.embed(t);
      },
    } as unknown as Embedder;
    const r = new SemanticRouter(fakeRuntime(spy), fakeClassifier(state), fakeClassifier(state));
    const systemOnly: NormalizedRequest = { model: 'auto', messages: [], params: {} };
    expect(await r.evaluate(principal, systemOnly, snapshot(true), GATE)).toEqual({ kind: 'skip' });
    expect(embedCalls).toBe(0);
  });

  it('fails open to skip when the embedder throws', async () => {
    const throwing = {
      id: 'x',
      dims: 64,
      embed: () => Promise.reject(new Error('boom')),
    } as unknown as Embedder;
    const r = new SemanticRouter(
      fakeRuntime(throwing),
      fakeClassifier(state),
      fakeClassifier(state),
    );
    expect(await r.evaluate(principal, ir('x'), snapshot(true), GATE)).toEqual({ kind: 'skip' });
  });

  it('passes the caller signal into embed (disconnect → skip)', async () => {
    let sawSignal: AbortSignal | undefined;
    const spy = {
      id: 'x',
      dims: 64,
      embed: (_t: string, o?: { signal?: AbortSignal }) => {
        sawSignal = o?.signal;
        return Promise.reject(new Error('aborted'));
      },
    } as unknown as Embedder;
    const ctl = new AbortController();
    const r = new SemanticRouter(fakeRuntime(spy), fakeClassifier(state), fakeClassifier(state));
    const res = await r.evaluate(principal, ir('x'), snapshot(true), GATE, { signal: ctl.signal });
    expect(res).toEqual({ kind: 'skip' });
    expect(sawSignal).toBe(ctl.signal);
  });
});
