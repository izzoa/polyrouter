/**
 * Builds a tiny, VALID ONNX model entirely in-process (no python, no binary
 * fixture in git): `out[1,S,8] = Mul(Unsqueeze(Cast(input_ids→float), axes=[2]), ones[8])`
 * — i.e. token t embeds to `[id_t ×8]`. Deterministic outputs
 * make the real-runtime integration test (task 3.5) assert exact pooled
 * values. Hand-rolled protobuf: ModelProto per onnx.proto3 (ir_version 8,
 * opset 13), raw_data tensors, expanded repeated fields — the conservative
 * encodings every conforming parser accepts.
 */

const WIRE_VARINT = 0;
const WIRE_LEN = 2;

function varint(n: number | bigint): Buffer {
  let v = BigInt(n);
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return Buffer.from(out);
}

function tag(field: number, wire: number): Buffer {
  return varint((field << 3) | wire);
}

function vint(field: number, n: number | bigint): Buffer {
  return Buffer.concat([tag(field, WIRE_VARINT), varint(n)]);
}

function lenDelim(field: number, bytes: Buffer): Buffer {
  return Buffer.concat([tag(field, WIRE_LEN), varint(bytes.length), bytes]);
}

function str(field: number, s: string): Buffer {
  return lenDelim(field, Buffer.from(s, 'utf8'));
}

/** AttributeProto: name(1), i(3), type(20)=INT(2). */
function intAttribute(name: string, value: number): Buffer {
  return Buffer.concat([str(1, name), vint(3, value), vint(20, 2)]);
}

/** NodeProto: input(1*), output(2*), op_type(4), attribute(5*). */
function node(opType: string, inputs: string[], outputs: string[], attrs: Buffer[] = []): Buffer {
  return Buffer.concat([
    ...inputs.map((i) => str(1, i)),
    ...outputs.map((o) => str(2, o)),
    str(4, opType),
    ...attrs.map((a) => lenDelim(5, a)),
  ]);
}

/** TensorProto: dims(1*), data_type(2), name(8), raw_data(9). */
function tensor(name: string, dataType: number, dims: number[], rawData: Buffer): Buffer {
  return Buffer.concat([
    ...dims.map((d) => vint(1, d)),
    vint(2, dataType),
    str(8, name),
    lenDelim(9, rawData),
  ]);
}

/** TensorShapeProto.Dimension: dim_value(1) | dim_param(2). */
function dim(v: number | string): Buffer {
  return typeof v === 'number' ? vint(1, v) : str(2, v);
}

/** ValueInfoProto: name(1), type(2: TypeProto{tensor_type(1: {elem_type(1), shape(2)})}). */
function valueInfo(name: string, elemType: number, dims: Array<number | string>): Buffer {
  const shape = Buffer.concat(dims.map((d) => lenDelim(1, dim(d))));
  const tensorType = Buffer.concat([vint(1, elemType), lenDelim(2, shape)]);
  const type = lenDelim(1, tensorType);
  return Buffer.concat([str(1, name), lenDelim(2, type)]);
}

const FLOAT = 1;
const INT64 = 7;

/** The complete model bytes. Inputs: input_ids/attention_mask int64 [1, seq]. */
export function buildFixtureModel(): Buffer {
  const axes = tensor(
    'axes',
    INT64,
    [1],
    (() => {
      const b = Buffer.alloc(8);
      b.writeBigInt64LE(2n);
      return b;
    })(),
  );
  const ones = tensor(
    'ones',
    FLOAT,
    [8],
    (() => {
      const b = Buffer.alloc(32);
      for (let i = 0; i < 8; i += 1) b.writeFloatLE(1, i * 4);
      return b;
    })(),
  );

  const graph = Buffer.concat([
    lenDelim(1, node('Cast', ['input_ids'], ['castf'], [intAttribute('to', FLOAT)])),
    lenDelim(1, node('Unsqueeze', ['castf', 'axes'], ['unsq'])),
    lenDelim(1, node('Mul', ['unsq', 'ones'], ['out'])),
    str(2, 'polyrouter-semantic-fixture'),
    lenDelim(5, axes),
    lenDelim(5, ones),
    lenDelim(11, valueInfo('input_ids', INT64, [1, 'seq'])),
    lenDelim(11, valueInfo('attention_mask', INT64, [1, 'seq'])),
    lenDelim(12, valueInfo('out', FLOAT, [1, 'seq', 8])),
  ]);

  // ModelProto: ir_version(1)=8, opset_import(8){version(2)=13}, graph(7).
  return Buffer.concat([vint(1, 8), lenDelim(7, graph), lenDelim(8, vint(2, 13))]);
}

export const FIXTURE_VOCAB = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'route', 'this', 'request'].join(
  '\n',
);

export const FIXTURE_MANIFEST = {
  schemaVersion: 1,
  tokenizer: {
    type: 'wordpiece',
    vocabFile: 'vocab.txt',
    lowercase: true,
    unkToken: '[UNK]',
    clsToken: '[CLS]',
    sepToken: '[SEP]',
    padToken: '[PAD]',
    maxTokens: 128,
  },
  model: {
    file: 'model.onnx',
    inputNames: { inputIds: 'input_ids', attentionMask: 'attention_mask' },
    outputName: 'out',
    outputKind: 'token_embeddings',
    dims: 8,
    pooling: 'mean',
    normalize: true,
  },
} as const;
