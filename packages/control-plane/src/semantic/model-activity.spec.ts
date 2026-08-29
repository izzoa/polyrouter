import { EmbedError, buildEmbedder, type InferenceLike, type TensorLike } from './embed-core';
import { WordPieceTokenizer, type BundleManifest } from './bundle';
import { observeAdmission } from './model-activity';
import { TrySemaphore } from './semaphore';

const VOCAB = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'route', 'this', 'request'].join('\n');

const MANIFEST: BundleManifest = {
  schemaVersion: 1,
  tokenizer: {
    type: 'wordpiece',
    vocabFile: 'vocab.txt',
    lowercase: true,
    unkToken: '[UNK]',
    clsToken: '[CLS]',
    sepToken: '[SEP]',
    padToken: '[PAD]',
    maxTokens: 512,
  },
  model: {
    file: 'model.onnx',
    inputNames: { inputIds: 'input_ids', attentionMask: 'attention_mask' },
    outputName: 'out',
    outputKind: 'token_embeddings',
    dims: 4,
    pooling: 'mean',
    normalize: true,
  },
};

const makeTensor = (ids: readonly number[]): TensorLike => ({
  data: [...ids],
  dims: [1, ids.length],
});

const okSession = (): InferenceLike => ({
  run: (feeds) => {
    const seq = feeds['input_ids']?.dims[1] ?? 0;
    return Promise.resolve({
      out: { data: new Float32Array(seq * 4).fill(1), dims: [1, seq, 4] },
    });
  },
});

const kindOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof EmbedError ? e.kind : 'other';
  }
};

/**
 * recover-semantic-centroid-build. The quiet gate is only as trustworthy as
 * these observations — each case here is one the obvious implementation gets
 * wrong.
 */
describe('model activity observation', () => {
  const seams = (width: number, session: InferenceLike, timeoutMs = 5000) => {
    const gate = observeAdmission(new TrySemaphore(width));
    const core = {
      id: 'sha256:test',
      manifest: MANIFEST,
      tokenizer: new WordPieceTokenizer(VOCAB, MANIFEST.tokenizer),
      session,
      makeTensor,
      maxInputChars: 2000,
    };
    return {
      activity: gate.activity,
      request: buildEmbedder({ ...core, timeoutMs, admission: gate.forPath('request') }),
      boot: buildEmbedder({ ...core, timeoutMs, admission: gate.forPath('boot') }),
    };
  };

  it('reports in-flight work that saturation does not — they are different questions', async () => {
    // Width 2 with one inference running: `saturated` is false, but the model
    // is emphatically not idle. A gate consulting saturation would rebuild
    // straight into live traffic.
    let settle: (() => void) | undefined;
    const held: InferenceLike = {
      run: (feeds) =>
        new Promise((resolve) => {
          const seq = feeds['input_ids']?.dims[1] ?? 0;
          settle = () =>
            resolve({ out: { data: new Float32Array(seq * 4).fill(1), dims: [1, seq, 4] } });
        }),
    };
    const s = seams(2, held);
    const pending = s.request.embed('route');
    await new Promise((r) => setTimeout(r, 5));

    expect(s.request.saturated).toBe(false);
    expect(s.activity.inferenceInFlight).toBe(true);
    expect(s.activity.isQuiet(0)).toBe(false);

    settle?.();
    await pending;
    expect(s.activity.inferenceInFlight).toBe(false);
  });

  it('keeps reporting activity after the CALLER gave up, until raw settlement', async () => {
    // THE case a wrapper around `embed()` gets wrong. The caller's promise
    // rejects on timeout; the native work runs on holding its permit. Reading
    // the caller's promise would call the model idle mid-inference.
    let settle: (() => void) | undefined;
    const held: InferenceLike = {
      run: (feeds) =>
        new Promise((resolve) => {
          const seq = feeds['input_ids']?.dims[1] ?? 0;
          settle = () =>
            resolve({ out: { data: new Float32Array(seq * 4).fill(1), dims: [1, seq, 4] } });
        }),
    };
    const s = seams(2, held, 10);
    await expect(kindOf(s.request.embed('route'))).resolves.toBe('timeout');

    expect(s.activity.inferenceInFlight).toBe(true); // caller unbound, raw runs on
    settle?.();
    await new Promise((r) => setTimeout(r, 5));
    expect(s.activity.inferenceInFlight).toBe(false); // released on RAW settle
  });

  it('counts a request REFUSED for saturation as traffic', async () => {
    // A refusal is the collision a rebuild must notice. Counting only
    // admissions would read the busiest instance as the quietest.
    const s = seams(1, { run: () => new Promise(() => undefined) });
    void s.boot.embed('route').catch(() => undefined); // boot holds the only permit
    await new Promise((r) => setTimeout(r, 5));
    expect(s.activity.lastRequestAttemptAt).toBeNull(); // boot is not traffic

    await expect(kindOf(s.request.embed('route'))).resolves.toBe('saturated');
    expect(s.activity.lastRequestAttemptAt).not.toBeNull();
    expect(s.activity.isQuiet(60_000)).toBe(false);
  });

  it('does not let background work refresh its own quiet clock', async () => {
    const s = seams(2, okSession());
    await s.boot.embed('route');
    expect(s.activity.lastRequestAttemptAt).toBeNull();
    expect(s.activity.isQuiet(60_000)).toBe(true); // still quiet after boot work
    await s.request.embed('route');
    expect(s.activity.isQuiet(60_000)).toBe(false);
  });

  it('discloses the real cost: a rebuild can make a HEALTHY source skip Layer 2', async () => {
    // The guarantee is that no request AWAITS a rebuild and none FAILS because
    // of one — NOT that routing is unaffected. At width 1 a background rebuild
    // holds the shared permit, so a concurrent request embed is refused and
    // skips Layer 2. That includes a BAND classification refused during a
    // WORKLOAD rebuild: a request whose own source was perfectly healthy.
    const s = seams(1, { run: () => new Promise(() => undefined) });
    void s.boot.embed('route').catch(() => undefined); // stands in for the rebuild
    await new Promise((r) => setTimeout(r, 5));

    // Immediate refusal — no queue, so the request never waits on the rebuild.
    const started = Date.now();
    await expect(kindOf(s.request.embed('route'))).resolves.toBe('saturated');
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('observes without changing admission', () => {
    // Width, no-queue rejection and release-on-settle must be the inner gate's.
    const inner = new TrySemaphore(1);
    const g = observeAdmission(inner);
    const a = g.forPath('request');
    expect(a.width).toBe(1);
    const release = a.tryAcquire();
    expect(release).not.toBeNull();
    expect(a.saturated).toBe(true);
    expect(g.forPath('boot').tryAcquire()).toBeNull(); // shared, not per-view
    release?.();
    release?.(); // idempotent — must not double-decrement either counter
    expect(a.saturated).toBe(false);
    expect(g.activity.inferenceInFlight).toBe(false);
  });
});
