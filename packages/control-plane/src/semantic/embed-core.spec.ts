import { WordPieceTokenizer, type BundleManifest } from './bundle';
import { EmbedError, buildEmbedder, type InferenceLike, type TensorLike } from './embed-core';
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

/** Session resolving constant token embeddings (every token = ones(4)). */
const okSession = (calls?: { count: number }): InferenceLike => ({
  run(feeds) {
    if (calls) calls.count += 1;
    const seq = feeds['input_ids']?.dims[1] ?? 0;
    return Promise.resolve({
      out: { data: new Float32Array(seq * 4).fill(1), dims: [1, seq, 4] },
    });
  },
});

const build = (session: InferenceLike, over?: Partial<Parameters<typeof buildEmbedder>[0]>) =>
  buildEmbedder({
    id: 'sha256:test',
    manifest: MANIFEST,
    tokenizer: new WordPieceTokenizer(VOCAB, MANIFEST.tokenizer),
    session,
    makeTensor,
    timeoutMs: 40,
    maxInputChars: 2000,
    admission: new TrySemaphore(2),
    ...over,
  });

const kindOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'resolved';
  } catch (err) {
    return err instanceof EmbedError ? err.kind : 'other';
  }
};

describe('buildEmbedder — happy path', () => {
  it('embeds to a validated unit vector of declared dims', async () => {
    const e = build(okSession());
    const v = await e.embed('route this request');
    expect(v).toHaveLength(4);
    // mean of ones → normalized → 0.5 each
    for (const x of v) expect(x).toBeCloseTo(0.5, 5);
    expect(e.id).toBe('sha256:test');
    expect(e.dims).toBe(4);
  });

  it('caps input chars BEFORE tokenization', async () => {
    let seenSeq = 0;
    const spy: InferenceLike = {
      run(feeds) {
        seenSeq = feeds['input_ids']?.dims[1] ?? 0;
        const seq = seenSeq;
        return Promise.resolve({
          out: { data: new Float32Array(seq * 4).fill(1), dims: [1, seq, 4] },
        });
      },
    };
    const e = build(spy, { maxInputChars: 200 });
    await e.embed('route '.repeat(500)); // 3000 chars, uncapped ≈ 502 tokens
    expect(seenSeq).toBeGreaterThan(0);
    expect(seenSeq).toBeLessThan(40); // 200 chars ≈ 33 words + [CLS]/[SEP]
  });
});

describe('buildEmbedder — the D6 semaphore/timeout matrix (clink r1 High-3)', () => {
  it('two never-settling runs time out but HOLD both permits; the third rejects saturated without touching the session', async () => {
    const calls = { count: 0 };
    const never: InferenceLike = {
      run() {
        calls.count += 1;
        return new Promise(() => undefined);
      },
    };
    const e = build(never, { timeoutMs: 15 });
    await expect(kindOf(e.embed('route'))).resolves.toBe('timeout');
    await expect(kindOf(e.embed('route'))).resolves.toBe('timeout');
    expect(calls.count).toBe(2);
    expect(e.saturated).toBe(true);
    await expect(kindOf(e.embed('route'))).resolves.toBe('saturated');
    expect(calls.count).toBe(2); // saturation never invoked the session
  });

  it('capacity returns ONLY when the raw inference settles', async () => {
    let settle: (() => void) | undefined;
    let firstRun = true;
    const controlled: InferenceLike = {
      run(feeds) {
        const seq = feeds['input_ids']?.dims[1] ?? 0;
        const ok = { out: { data: new Float32Array(seq * 4).fill(1), dims: [1, seq, 4] } };
        if (!firstRun) return Promise.resolve(ok);
        firstRun = false;
        return new Promise((resolve) => {
          settle = (): void => {
            resolve(ok);
          };
        });
      },
    };
    const e = build(controlled, { timeoutMs: 15, admission: new TrySemaphore(1) });
    await expect(kindOf(e.embed('route'))).resolves.toBe('timeout');
    expect(e.saturated).toBe(true); // caller unbound, permit held
    settle?.();
    await new Promise((r) => setTimeout(r, 5));
    expect(e.saturated).toBe(false); // raw settled → permit released
    await expect(e.embed('route')).resolves.toHaveLength(4);
  });

  it('a late native rejection is consumed — no unhandled rejection', async () => {
    let unhandled = 0;
    const onUnhandled = (): void => {
      unhandled += 1;
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const lateReject: InferenceLike = {
        run() {
          return new Promise((_, reject) =>
            setTimeout(() => {
              reject(new Error('late native boom'));
            }, 30),
          );
        },
      };
      const e = build(lateReject, { timeoutMs: 10 });
      await expect(kindOf(e.embed('route'))).resolves.toBe('timeout');
      await new Promise((r) => setTimeout(r, 40)); // let the late rejection land
      expect(unhandled).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('early completion clears its timer', async () => {
    jest.useFakeTimers();
    try {
      const e = build(okSession());
      const p = e.embed('route');
      await jest.runAllTimersAsync();
      await expect(p).resolves.toHaveLength(4);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('abort: pre-aborted rejects immediately; mid-flight abort unbinds the caller, permit follows raw', async () => {
    const pre = new AbortController();
    pre.abort();
    const e1 = build(okSession());
    await expect(kindOf(e1.embed('route', { signal: pre.signal }))).resolves.toBe('aborted');

    const never: InferenceLike = { run: () => new Promise(() => undefined) };
    const e2 = build(never, { timeoutMs: 5000, admission: new TrySemaphore(1) });
    const ctl = new AbortController();
    const p = e2.embed('route', { signal: ctl.signal });
    ctl.abort();
    await expect(kindOf(p)).resolves.toBe('aborted');
    expect(e2.saturated).toBe(true); // raw never settled — permit held
  });
});

describe('buildEmbedder — output validation + privacy (D6/D9)', () => {
  it('rejects wrong SHAPES that would pool into plausible vectors (impl-clink High-1)', async () => {
    // [1,1,4] with 4 data values: zero-filled pooling would have produced a
    // "valid" unit vector before shape enforcement.
    const squashed: InferenceLike = {
      run: () => Promise.resolve({ out: { data: new Float32Array(4).fill(1), dims: [1, 1, 4] } }),
    };
    await expect(kindOf(build(squashed).embed('route this request'))).resolves.toBe(
      'invalid_output',
    );

    const lengthLies: InferenceLike = {
      run: (feeds) => {
        const seq = feeds['input_ids']?.dims[1] ?? 0;
        return Promise.resolve({
          out: { data: new Float32Array(4).fill(1), dims: [1, seq, 4] }, // dims claim seq, data is short
        });
      },
    };
    await expect(kindOf(build(lengthLies).embed('route this request'))).resolves.toBe(
      'invalid_output',
    );
  });

  it('rejects invalid outputs typed', async () => {
    const nan: InferenceLike = {
      run: (feeds) =>
        Promise.resolve({
          out: {
            data: new Float32Array((feeds['input_ids']?.dims[1] ?? 0) * 4).fill(Number.NaN),
            dims: [1, feeds['input_ids']?.dims[1] ?? 0, 4],
          },
        }),
    };
    await expect(kindOf(build(nan).embed('route'))).resolves.toBe('invalid_output');

    const missing: InferenceLike = { run: () => Promise.resolve({}) };
    await expect(kindOf(build(missing).embed('route'))).resolves.toBe('invalid_output');
  });

  it('sentinel input never appears in any error message', async () => {
    const SENTINEL = 'SENTINEL_9Q7Z_PRIVATE_PROMPT';
    const messages: string[] = [];
    const capture = async (p: Promise<unknown>): Promise<void> => {
      try {
        await p;
      } catch (err) {
        messages.push(err instanceof Error ? err.message : String(err));
      }
    };
    const boom: InferenceLike = { run: () => Promise.reject(new Error('native failure')) };
    const never: InferenceLike = { run: () => new Promise(() => undefined) };
    const missing: InferenceLike = { run: () => Promise.resolve({}) };
    await capture(build(boom).embed(SENTINEL));
    await capture(build(never, { timeoutMs: 10 }).embed(SENTINEL));
    await capture(build(missing).embed(SENTINEL));
    const sat = build(never, { timeoutMs: 10, admission: new TrySemaphore(1) });
    void kindOf(sat.embed(SENTINEL));
    await capture(sat.embed(SENTINEL));
    expect(messages.length).toBeGreaterThanOrEqual(4);
    for (const m of messages) expect(m).not.toContain('SENTINEL');
  });
});

/**
 * fix-semantic-boot-embed-budget: the seam has TWO bounds over ONE model, and
 * the admission gate is shared across them. These pin the properties the field
 * defect turned on — a boot embed must not be judged by the request rail, and
 * splitting the gate must not silently raise the orphaned-work ceiling.
 */
describe('two-tier bounds over one shared admission gate', () => {
  /** A session whose inference takes `ms` — the shape of a host slower than
   * the request rail but perfectly healthy. */
  const slowSession = (ms: number): InferenceLike => ({
    run: (feeds) =>
      new Promise((resolve) => {
        const seq = (feeds['input_ids'] as TensorLike).dims[1] ?? 1;
        setTimeout(
          () => resolve({ out: { data: new Float32Array(seq * 4).fill(1), dims: [1, seq, 4] } }),
          ms,
        );
      }),
  });

  it('a boot-path embed outlives the request rail; a request-path embed does not', async () => {
    // ONE gate, two seams — exactly what the loader now returns.
    const gate = new TrySemaphore(2);
    const session = slowSession(60); // > the 50ms-class request rail
    const request = build(session, { timeoutMs: 50, admission: gate });
    const boot = build(session, { timeoutMs: 30_000, admission: gate });

    await expect(kindOf(request.embed('route'))).resolves.toBe('timeout');
    await expect(boot.embed('route')).resolves.toHaveLength(4);
  });

  it('the in-flight native ceiling is shared, not per-tier', async () => {
    // Width 1: once boot's orphaned work holds the permit, a request embed on
    // the OTHER seam must see saturation. With a gate per seam it would not —
    // which is precisely the guarantee that would have been voided.
    const gate = new TrySemaphore(1);
    const never: InferenceLike = { run: () => new Promise(() => undefined) };
    const boot = build(never, { timeoutMs: 30_000, admission: gate });
    const request = build(never, { timeoutMs: 10, admission: gate });

    void kindOf(boot.embed('route')); // admitted; raw never settles
    await new Promise((r) => setTimeout(r, 5));
    // Rejects IMMEDIATELY (no queue) — the request proceeds without the layer.
    await expect(kindOf(request.embed('route'))).resolves.toBe('saturated');
    expect(request.saturated).toBe(true);
    expect(boot.saturated).toBe(true); // one gate, one truth
  });

  it('reports the width that actually governs admission', async () => {
    // One source of truth: an injected width of 1 must never report width 2.
    const gate = new TrySemaphore(1);
    const never: InferenceLike = { run: () => new Promise(() => undefined) };
    const a = build(never, { timeoutMs: 5000, admission: gate });
    void a.embed('route').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 5));
    await expect(a.embed('route').catch((e: Error) => e.message)).resolves.toContain('width 1');
  });

  it('starts no inference once the abort has actually fired', async () => {
    // An abort that already fired before the call reaches dispatch starts
    // nothing. The wall-clock case — deadline crossed DURING synchronous
    // tokenization, so the timer callback has not run and `aborted` is still
    // false — is covered by the next test, via the seam's own entry deadline.
    let runs = 0;
    const counting: InferenceLike = {
      run: (feeds) => {
        runs += 1;
        const seq = (feeds['input_ids'] as TensorLike).dims[1] ?? 1;
        return Promise.resolve({
          out: { data: new Float32Array(seq * 4).fill(1), dims: [1, seq, 4] },
        });
      },
    };
    const ctl = new AbortController();
    ctl.abort(); // already aborted — the state a fired phase deadline leaves
    const e = build(counting, { timeoutMs: 5000, admission: new TrySemaphore(2) });
    await expect(kindOf(e.embed('route', { signal: ctl.signal }))).resolves.toBe('aborted');
    expect(runs).toBe(0);
  });

  it('starts no inference when tokenizing crosses the seam deadline', async () => {
    // The window a signal CANNOT cover: a timer callback cannot interrupt
    // synchronous work, so `aborted` is still false when preprocessing ends.
    // A boot phase asks for a seam bounded by its REMAINING budget, which makes
    // the seam's entry deadline the phase deadline — and the pipeline's
    // before-dispatch check then refuses to start the inference.
    let runs = 0;
    const counting: InferenceLike = {
      run: (feeds) => {
        runs += 1;
        const seq = (feeds['input_ids'] as TensorLike).dims[1] ?? 1;
        return Promise.resolve({
          out: { data: new Float32Array(seq * 4).fill(1), dims: [1, seq, 4] },
        });
      },
    };
    // A tokenizer that burns the whole (1ms) budget before returning.
    const slowTokenizer = new WordPieceTokenizer(VOCAB, MANIFEST.tokenizer);
    const realEncode = slowTokenizer.encode.bind(slowTokenizer);
    slowTokenizer.encode = (text: string) => {
      const until = Date.now() + 5;
      while (Date.now() < until) {
        /* synchronous, exactly like real tokenization */
      }
      return realEncode(text);
    };
    const e = build(counting, {
      timeoutMs: 1,
      tokenizer: slowTokenizer,
      admission: new TrySemaphore(2),
    });
    await expect(kindOf(e.embed('route'))).resolves.toBe('timeout');
    expect(runs).toBe(0);
  });
});
