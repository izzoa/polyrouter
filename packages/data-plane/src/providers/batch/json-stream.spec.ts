import {
  JsonStreamError,
  bytesOf,
  readJsonLines,
  scanTopLevelObject,
  type JsonStreamEvent,
} from './json-stream';

const enc = new TextEncoder();

/** Feed text in fixed-size byte chunks (1 = every byte its own chunk). */
// eslint-disable-next-line @typescript-eslint/require-await -- an async source by contract
async function* chunks(text: string, size: number): AsyncGenerator<Uint8Array> {
  const bytes = enc.encode(text);
  for (let i = 0; i < bytes.length; i += size) yield bytes.slice(i, i + size);
}

async function collect(
  text: string,
  size = 7,
  arrayKeys = ['requests'],
  max = 1 << 20,
): Promise<JsonStreamEvent[]> {
  const out: JsonStreamEvent[] = [];
  for await (const ev of scanTopLevelObject(chunks(text, size), { arrayKeys, maxValueBytes: max }))
    out.push(ev);
  return out;
}

describe('scanTopLevelObject', () => {
  const doc = JSON.stringify({
    endpoint: '/v1/chat/completions',
    model: 'openai/gpt-4o',
    nested: { a: [1, 2, { b: ']}' }], s: 'x,y}' },
    requests: [
      { custom_id: 'a', body: { messages: [{ role: 'user', content: 'hi, "there" ]}' }] } },
      { custom_id: 'b', body: { n: 1, t: true, z: null, arr: [[]] } },
      'scalar',
      42,
    ],
    after: 'tail',
  });

  it.each([1, 3, 7, 64, 100_000])(
    'streams the named array element by element with %i-byte chunks',
    async (size) => {
      const events = await collect(doc, size);
      const kinds = events.map((e) => e.type);
      expect(kinds).toEqual([
        'member',
        'member',
        'member',
        'array_start',
        'element',
        'element',
        'element',
        'element',
        'array_end',
        'member',
      ]);
      const members = Object.fromEntries(
        events.filter((e) => e.type === 'member').map((e) => [e.key, e.value]),
      );
      expect(members).toEqual({
        endpoint: '/v1/chat/completions',
        model: 'openai/gpt-4o',
        nested: { a: [1, 2, { b: ']}' }], s: 'x,y}' },
        after: 'tail',
      });
      const elements = events.filter((e) => e.type === 'element').map((e) => e.value);
      expect(elements).toEqual([
        { custom_id: 'a', body: { messages: [{ role: 'user', content: 'hi, "there" ]}' }] } },
        { custom_id: 'b', body: { n: 1, t: true, z: null, arr: [[]] } },
        'scalar',
        42,
      ]);
      const end = events.find((e) => e.type === 'array_end');
      expect(end).toEqual({ type: 'array_end', key: 'requests', count: 4 });
    },
  );

  it('reports each element byte size and keeps multibyte text intact across chunk boundaries', async () => {
    const text = JSON.stringify({ requests: [{ t: 'héllo 😀 — ünïcode' }] });
    const events = await collect(text, 1);
    const el = events.find((e) => e.type === 'element');
    expect(el).toMatchObject({ value: { t: 'héllo 😀 — ünïcode' } });
    expect((el as { bytes: number }).bytes).toBe(
      Buffer.byteLength(JSON.stringify({ t: 'héllo 😀 — ünïcode' })),
    );
  });

  it('treats the named key as an ordinary member when its value is not an array', async () => {
    const events = await collect('{"requests": null, "x": [1]}');
    expect(events).toEqual([
      { type: 'member', key: 'requests', value: null },
      { type: 'member', key: 'x', value: [1] },
    ]);
  });

  it('handles an empty object and an empty streamed array', async () => {
    expect(await collect('{}')).toEqual([]);
    expect(await collect(' { "requests" : [ ] } ')).toEqual([
      { type: 'array_start', key: 'requests' },
      { type: 'array_end', key: 'requests', count: 0 },
    ]);
  });

  it('bounds every buffered value and element by bytes', async () => {
    const big = JSON.stringify({ blob: 'x'.repeat(2_000) });
    await expect(collect(big, 7, ['requests'], 1_000)).rejects.toMatchObject({
      reason: 'too_large',
    });
    const bigElement = JSON.stringify({ requests: [{ t: 'y'.repeat(2_000) }] });
    await expect(collect(bigElement, 7, ['requests'], 1_000)).rejects.toMatchObject({
      reason: 'too_large',
    });
    // Many small elements are fine under the same cap — the bound is per element.
    const many = JSON.stringify({ requests: Array.from({ length: 500 }, (_, i) => ({ i })) });
    expect(
      (await collect(many, 64, ['requests'], 64)).filter((e) => e.type === 'element'),
    ).toHaveLength(500);
  });

  it.each([
    ['[1]', 'not_object'],
    ['{"a" 1}', 'malformed'],
    ['{"a": }', 'malformed'],
    ['{"requests": [1,]}', 'malformed'],
    ['{"requests": [,1]}', 'malformed'],
    ['{"requests": [1] "x": 1}', 'malformed'],
    ['{"a": 1} trailing', 'malformed'],
    ['{"a": {"b": 1}', 'truncated'],
    ['{"requests": [1, 2', 'truncated'],
    ['{"a": tru}', 'malformed'],
    ['{"requests": [1, {"x": ]}]}', 'malformed'],
  ])('rejects %s as %s, never hanging', async (text, reason) => {
    await expect(collect(text)).rejects.toBeInstanceOf(JsonStreamError);
    await expect(collect(text)).rejects.toMatchObject({ reason });
  });
});

describe('readJsonLines', () => {
  it('yields each non-empty line parsed, tolerating CRLF, a missing final newline and chunk splits', async () => {
    const text = '{"a":1}\r\n\n{"b":"x\\ny"}\n{"c":[1,2]}';
    const out: unknown[] = [];
    for await (const v of readJsonLines(chunks(text, 3), 1 << 16)) out.push(v);
    expect(out).toEqual([{ a: 1 }, { b: 'x\ny' }, { c: [1, 2] }]);
  });

  it('bounds a line and rejects a malformed one', async () => {
    await expect(
      (async () => {
        for await (const _ of readJsonLines(chunks(`{"t":"${'z'.repeat(300)}"}\n`, 50), 100))
          void _;
      })(),
    ).rejects.toMatchObject({ reason: 'too_large' });
    await expect(
      (async () => {
        for await (const _ of readJsonLines(chunks('{"ok":1}\n{nope}\n', 4), 1000)) void _;
      })(),
    ).rejects.toMatchObject({ reason: 'malformed' });
  });
});

describe('bytesOf', () => {
  it('iterates a web stream and releases it on early exit', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(enc.encode('x'));
      },
      cancel() {
        cancelled = true;
      },
    });
    let seen = 0;
    for await (const chunk of bytesOf(stream)) {
      seen += chunk.length;
      if (seen >= 3) break;
    }
    expect(seen).toBe(3);
    expect(cancelled).toBe(true);
    const empty: Uint8Array[] = [];
    for await (const c of bytesOf(null)) empty.push(c);
    expect(empty).toEqual([]);
  });
});
