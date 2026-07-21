import {
  BundleError,
  WordPieceTokenizer,
  contentHashId,
  l2Normalize,
  meanPoolNormalize,
  parseManifest,
  validateVector,
  type BundleManifest,
} from './bundle';

const VOCAB = [
  '[PAD]', // 0
  '[UNK]', // 1
  '[CLS]', // 2
  '[SEP]', // 3
  'route', // 4
  'this', // 5
  'request', // 6
  '##s', // 7
  '!', // 8
  'hello', // 9
  'café', // 10
  'un', // 11
  '##believ', // 12
  '##able', // 13
  ',', // 14
].join('\n');

const TOK_CFG: BundleManifest['tokenizer'] = {
  type: 'wordpiece',
  vocabFile: 'vocab.txt',
  lowercase: true,
  unkToken: '[UNK]',
  clsToken: '[CLS]',
  sepToken: '[SEP]',
  padToken: '[PAD]',
  maxTokens: 64,
};

const manifest = (over?: Partial<BundleManifest['tokenizer']>): BundleManifest['tokenizer'] => ({
  ...TOK_CFG,
  ...over,
});

describe('WordPieceTokenizer (golden sequences)', () => {
  const tok = new WordPieceTokenizer(VOCAB, TOK_CFG);

  it.each<[string, number[]]>([
    ['route this request', [2, 4, 5, 6, 3]],
    ['requests', [2, 6, 7, 3]], // request + ##s
    ['hello!', [2, 9, 8, 3]], // punctuation splits into its own token
    ['unbelievable', [2, 11, 12, 13, 3]], // greedy longest-match with ## continuation
    ['xyzzy', [2, 1, 3]], // unmatchable word → [UNK] as a whole
    ['Route THIS', [2, 4, 5, 3]], // lowercase: true
    ['route,this', [2, 4, 14, 5, 3]],
    ['', [2, 3]],
  ])('%j → %j', (text, ids) => {
    expect(tok.encode(text).ids).toEqual(ids);
  });

  it('NFC-normalizes: composed and decomposed café agree', () => {
    const composed = 'café';
    const decomposed = 'café';
    expect(tok.encode(composed).ids).toEqual([2, 10, 3]);
    expect(tok.encode(decomposed).ids).toEqual(tok.encode(composed).ids);
  });

  it('hard-truncates at maxTokens with the trailing [SEP] intact', () => {
    const tiny = new WordPieceTokenizer(VOCAB, manifest({ maxTokens: 6 }));
    const { ids, attentionMask } = tiny.encode('route this request hello route this');
    expect(ids).toHaveLength(6);
    expect(ids[0]).toBe(2);
    expect(ids[5]).toBe(3);
    expect(attentionMask).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('rejects a vocab missing a declared special token', () => {
    expect(() => new WordPieceTokenizer('a\nb\nc', TOK_CFG)).toThrow(BundleError);
    expect(() => new WordPieceTokenizer('a\nb\nc', TOK_CFG)).toThrow('unkToken');
  });

  it('maps words beyond the fixed 100-char guard to [UNK] wholesale (BERT convention)', () => {
    const long = 'route'.repeat(21); // 105 chars, entirely pieceable otherwise
    expect(tok.encode(long).ids).toEqual([2, 1, 3]);
  });

  it('splits ASCII symbols but keeps non-ASCII symbols inside the word (declared rule)', () => {
    // '$' sits in the ASCII 33–47 band → its own token (unmatchable → UNK);
    // '€' is \p{Sc}, NOT split → 'route€' is one unmatchable word → one UNK.
    expect(tok.encode('route$').ids).toEqual([2, 4, 1, 3]);
    expect(tok.encode('route€').ids).toEqual([2, 1, 3]);
  });

  it('preserves case when lowercase is false', () => {
    const cased = new WordPieceTokenizer(VOCAB, manifest({ lowercase: false }));
    expect(cased.encode('Route').ids).toEqual([2, 1, 3]); // "Route" not in vocab
  });
});

describe('meanPoolNormalize / validateVector', () => {
  it('pools only masked tokens then unit-normalizes', () => {
    // seq=3, dims=2: (1,0), (3,4), (100,100) with the last masked out.
    const data = new Float32Array([1, 0, 3, 4, 100, 100]);
    const v = meanPoolNormalize(data, 3, 2, [1, 1, 0]);
    // mean = (2, 2) → normalized → (√½, √½)
    expect(v[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(v[1]).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it('throws on an all-zero mask', () => {
    expect(() => meanPoolNormalize(new Float32Array(4), 2, 2, [0, 0])).toThrow('attention mask');
  });

  it('l2Normalize rejects zero and non-finite norms', () => {
    expect(() => l2Normalize(new Float32Array(3))).toThrow(BundleError);
    expect(() => l2Normalize(new Float32Array([Number.NaN, 1]))).toThrow(BundleError);
  });

  it('validateVector enforces dims, finiteness, and unit norm', () => {
    const unit = new Float32Array([1, 0]);
    expect(() => validateVector(unit, 2)).not.toThrow();
    expect(() => validateVector(unit, 3)).toThrow('dims');
    expect(() => validateVector(new Float32Array([Number.NaN, 0]), 2)).toThrow('non-finite');
    expect(() => validateVector(new Float32Array([3, 4]), 2)).toThrow('unit-norm');
  });
});

describe('parseManifest', () => {
  const good = {
    schemaVersion: 1,
    tokenizer: { ...TOK_CFG },
    model: {
      file: 'model.onnx',
      inputNames: { inputIds: 'input_ids', attentionMask: 'attention_mask' },
      outputName: 'last_hidden_state',
      outputKind: 'token_embeddings',
      dims: 384,
      pooling: 'mean',
      normalize: true,
    },
  };

  it('accepts a valid v1 manifest', () => {
    const m = parseManifest(Buffer.from(JSON.stringify(good)));
    expect(m.model.dims).toBe(384);
    expect(m.tokenizer.type).toBe('wordpiece');
  });

  it('names the offending field, never file contents', () => {
    const bad = { ...good, model: { ...good.model, dims: 'huge' } };
    const attempt = (): BundleManifest => parseManifest(Buffer.from(JSON.stringify(bad)));
    expect(attempt).toThrow(BundleError);
    expect(attempt).toThrow('model.dims');
    expect(attempt).not.toThrow('huge');
  });

  it('rejects non-JSON and unsupported tokenizer types', () => {
    expect(() => parseManifest(Buffer.from('nope{'))).toThrow('not valid JSON');
    const bpe = { ...good, tokenizer: { ...good.tokenizer, type: 'bpe' } };
    expect(() => parseManifest(Buffer.from(JSON.stringify(bpe)))).toThrow('tokenizer.type');
  });

  it('is STRICT: undeclarable fields reject instead of silently dropping (impl-clink Med-2)', () => {
    const extra = { ...good, tokenizer: { ...good.tokenizer, stripAccents: true } };
    expect(() => parseManifest(Buffer.from(JSON.stringify(extra)))).toThrow(BundleError);
    const rootExtra = { ...good, experimental: {} };
    expect(() => parseManifest(Buffer.from(JSON.stringify(rootExtra)))).toThrow(BundleError);
  });

  it('constrains declared files to flat bundle names (impl-clink Med-3)', () => {
    for (const evil of ['../evil.onnx', 'sub/model.onnx', '/etc/passwd', 'manifest.json']) {
      const bad = { ...good, model: { ...good.model, file: evil } };
      expect(() => parseManifest(Buffer.from(JSON.stringify(bad)))).toThrow(BundleError);
    }
    const dupe = { ...good, tokenizer: { ...good.tokenizer, vocabFile: 'model.onnx' } };
    expect(() => parseManifest(Buffer.from(JSON.stringify(dupe)))).toThrow('must differ');
  });

  it('requires distinct input tensor names (impl-clink High-1)', () => {
    const clash = {
      ...good,
      model: { ...good.model, inputNames: { inputIds: 'x', attentionMask: 'x' } },
    };
    expect(() => parseManifest(Buffer.from(JSON.stringify(clash)))).toThrow('distinct');
  });
});

describe('contentHashId', () => {
  const m = Buffer.from('{"schemaVersion":1}');
  const files = [
    { relPath: 'model.onnx', bytes: Buffer.from([1, 2, 3]) },
    { relPath: 'vocab.txt', bytes: Buffer.from('a\nb') },
  ];

  it('is order-independent over declared files and stable across mount paths', () => {
    const a = contentHashId(m, files);
    const b = contentHashId(m, [...files].reverse());
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes when any byte, name, or the manifest changes', () => {
    const base = contentHashId(m, files);
    expect(
      contentHashId(m, [files[0]!, { relPath: 'vocab.txt', bytes: Buffer.from('a\nc') }]),
    ).not.toBe(base);
    expect(
      contentHashId(m, [{ ...files[0]!, relPath: 'model2.onnx' }, files[1]!]),
    ).not.toBe(base);
    expect(contentHashId(Buffer.from('{"schemaVersion":1 }'), files)).not.toBe(base);
  });
});
