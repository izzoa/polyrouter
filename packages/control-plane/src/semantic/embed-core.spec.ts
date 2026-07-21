import { WordPieceTokenizer, type BundleManifest } from './bundle';
import { EmbedError, buildEmbedder, type InferenceLike, type TensorLike } from './embed-core';

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
    concurrency: 2,
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
    const e = build(controlled, { timeoutMs: 15, concurrency: 1 });
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
    const e2 = build(never, { timeoutMs: 5000, concurrency: 1 });
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
    const sat = build(never, { timeoutMs: 10, concurrency: 1 });
    void kindOf(sat.embed(SENTINEL));
    await capture(sat.embed(SENTINEL));
    expect(messages.length).toBeGreaterThanOrEqual(4);
    for (const m of messages) expect(m).not.toContain('SENTINEL');
  });
});
