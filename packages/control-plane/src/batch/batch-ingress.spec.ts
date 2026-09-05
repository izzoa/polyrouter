// add-batch-inference task 3.1: the streaming submission parser — ordering rule,
// bounds, per-item validation naming the first offending custom_id, translation
// through the same IR as a synchronous request, and the envelope switch.
import { BatchIngressError, parseBatchSubmission, type BatchIngressBounds } from './batch-ingress';

const enc = new TextEncoder();
// eslint-disable-next-line @typescript-eslint/require-await -- an async source by contract
async function* chunks(text: string, size = 5): AsyncGenerator<Uint8Array> {
  const bytes = enc.encode(text);
  for (let i = 0; i < bytes.length; i += size) yield bytes.slice(i, i + size);
}

const BOUNDS: BatchIngressBounds = { maxItems: 100, maxBodyBytes: 1 << 20 };
const item = (id: string, body: Record<string, unknown> = {}) => ({
  custom_id: id,
  body: { messages: [{ role: 'user', content: `hi ${id}` }], max_tokens: 8, ...body },
});
const doc = (over: Record<string, unknown> = {}, ...items: unknown[]): string =>
  JSON.stringify({ endpoint: '/v1/chat/completions', model: 'gpt-4o', ...over, requests: items });

async function failure(text: string, bounds = BOUNDS): Promise<BatchIngressError> {
  try {
    await parseBatchSubmission(chunks(text), bounds);
  } catch (e) {
    if (e instanceof BatchIngressError) return e;
    throw e;
  }
  throw new Error('expected a BatchIngressError');
}

describe('parseBatchSubmission', () => {
  it('translates each item into the IR, keeps custom_ids and the chars/4 inputs, and reports bytes', async () => {
    const text = doc({}, item('a'), item('b', { max_tokens: 3, temperature: 0.5 }));
    const parsed = await parseBatchSubmission(chunks(text, 3), BOUNDS);
    expect(parsed.endpoint).toBe('/v1/chat/completions');
    expect(parsed.model).toBe('gpt-4o');
    expect(parsed.bytes).toBe(enc.encode(text).byteLength);
    expect(parsed.items.map((i) => i.customId)).toEqual(['a', 'b']);
    expect(parsed.items[0]!.request.messages[0]!.content).toEqual([{ type: 'text', text: 'hi a' }]);
    expect(parsed.items[0]!.maxOutputTokens).toBe(8);
    expect(parsed.items[1]!.maxOutputTokens).toBe(3);
    expect(parsed.items[1]!.request.params.temperature).toBe(0.5);
    expect(parsed.items[0]!.chars).toBe(Buffer.byteLength(JSON.stringify(item('a'))));
  });

  it('parses Anthropic-shaped items through the Anthropic client adapter and switches the envelope', async () => {
    const seen: string[] = [];
    const text = JSON.stringify({
      endpoint: '/v1/messages',
      model: 'claude-x',
      requests: [
        {
          custom_id: 'm1',
          body: {
            max_tokens: 5,
            system: 'Be terse.',
            messages: [{ role: 'user', content: 'hey' }],
          },
        },
      ],
    });
    const parsed = await parseBatchSubmission(chunks(text), BOUNDS, {
      onEndpoint: (e) => seen.push(e),
    });
    expect(seen).toEqual(['/v1/messages']);
    expect(parsed.items[0]!.request.system).toEqual([{ type: 'text', text: 'Be terse.' }]);
    // A failure after the endpoint is known renders in the endpoint's envelope.
    const err = await failure(
      JSON.stringify({
        endpoint: '/v1/messages',
        model: 'claude-x',
        requests: [{ custom_id: 'x', body: { messages: [], max_tokens: 1, stream: true } }],
      }),
    );
    expect(err.protocol).toBe('anthropic');
    expect(err.proxyError.code).toBe('batch_item_invalid');
  });

  it('refuses requests before endpoint/model without reading an item, in the OpenAI envelope', async () => {
    const err = await failure(
      JSON.stringify({ requests: [item('a')], endpoint: '/v1/chat/completions', model: 'm' }),
    );
    expect(err.protocol).toBe('openai');
    expect(err.proxyError.status).toBe(400);
    expect(err.proxyError.code).toBe('batch_invalid');
    expect(err.proxyError.publicMessage).toMatch(/precede requests/);
  });

  it('runs beforeItems once after the head and before the first item, honouring its bounds', async () => {
    let calls = 0;
    const parsed = await parseBatchSubmission(chunks(doc({}, item('ok'))), BOUNDS, {
      beforeItems: (head) => {
        calls += 1;
        expect(head).toEqual({ endpoint: '/v1/chat/completions', model: 'gpt-4o' });
        return Promise.resolve({ maxUpstreamItems: 1 });
      },
    });
    expect(calls).toBe(1);
    expect(parsed.items).toHaveLength(1);
    const over = await (async () => {
      try {
        await parseBatchSubmission(chunks(doc({}, item('a'), item('b'))), BOUNDS, {
          beforeItems: () => Promise.resolve({ maxUpstreamItems: 1 }),
        });
      } catch (e) {
        return e as BatchIngressError;
      }
      throw new Error('expected failure');
    })();
    expect(over.proxyError.code).toBe('batch_too_large');
    expect(over.proxyError.status).toBe(413);
  });

  it.each([
    ['stream: true', item('s1', { stream: true }), 's1', /stream: true/],
    ['n > 1', item('n2', { n: 2 }), 'n2', /n > 1/],
    ['a mismatched model', item('m3', { model: 'other' }), 'm3', /different from the batch model/],
    ['an invalid body', { custom_id: 'b4', body: { max_tokens: 1 } }, 'b4', /invalid body/],
    ['a non-object body', { custom_id: 'b5', body: 'text' }, 'b5', /object body/],
  ])(
    'rejects an item with %s naming the first offending custom_id',
    async (_label, bad, id, rule) => {
      const err = await failure(doc({}, item('fine'), bad, item('never-read')));
      expect(err.proxyError.status).toBe(400);
      expect(err.proxyError.code).toBe('batch_item_invalid');
      expect(err.proxyError.publicMessage).toContain(`"${id}"`);
      expect(err.proxyError.publicMessage).toMatch(rule);
    },
  );

  it('rejects a duplicate custom_id, a missing one, and a provider-refused grammar', async () => {
    const dup = await failure(doc({}, item('same'), item('same')));
    expect(dup.proxyError.publicMessage).toMatch(/"same" duplicates/);
    const missing = await failure(doc({}, { body: {} }));
    expect(missing.proxyError.publicMessage).toMatch(/without a custom_id/);
    const grammar = await failure(doc({}, item('has space')), {
      ...BOUNDS,
      customIdPattern: /^[a-zA-Z0-9_-]{1,64}$/,
    });
    expect(grammar.proxyError.publicMessage).toMatch(
      /"has space" has a custom_id the provider does not accept/,
    );
  });

  it('refuses auto, an unknown endpoint, an empty requests array, and malformed JSON by name', async () => {
    expect((await failure(doc({ model: 'auto' }, item('a')))).proxyError.code).toBe(
      'batch_auto_not_allowed',
    );
    expect((await failure(doc({ model: 'AUTO' }, item('a')))).proxyError.code).toBe(
      'batch_auto_not_allowed',
    );
    expect(
      (await failure(doc({ endpoint: '/v1/embeddings' }, item('a')))).proxyError.publicMessage,
    ).toMatch(/endpoint must be one of/);
    expect((await failure(doc({}))).proxyError.publicMessage).toMatch(/non-empty array/);
    expect(
      (await failure('{"endpoint": "/v1/chat/completions", "model": "m", "requests": [{'))
        .proxyError.publicMessage,
    ).toMatch(/malformed JSON/);
    expect(
      (
        await failure(
          JSON.stringify({ endpoint: '/v1/chat/completions', model: 'm', requests: null }),
        )
      ).proxyError.publicMessage,
    ).toMatch(/non-empty array/);
  });

  it('enforces the item and byte bounds as a 413 and stops reading at the bound', async () => {
    const many = await failure(doc({}, item('1'), item('2'), item('3')), {
      ...BOUNDS,
      maxItems: 2,
    });
    expect(many.proxyError.status).toBe(413);
    expect(many.proxyError.publicMessage).toMatch(/more than 2 items/);
    let pulled = 0;
    const big = doc({}, item('x', { pad: 'y'.repeat(5_000) }));
    const counted = (async function* () {
      for await (const c of chunks(big, 100)) {
        pulled += c.byteLength;
        yield c;
      }
    })();
    const err = await (async () => {
      try {
        await parseBatchSubmission(counted, { ...BOUNDS, maxBodyBytes: 1_000 });
      } catch (e) {
        return e as BatchIngressError;
      }
      throw new Error('expected failure');
    })();
    expect(err.proxyError.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(1_100); // stopped at the bound, not at the end
  });

  it('ignores unknown top-level members such as metadata and completion_window', async () => {
    const parsed = await parseBatchSubmission(
      chunks(doc({ metadata: { run: 'nightly' }, completion_window: '24h' }, item('a'))),
      BOUNDS,
    );
    expect(parsed.items).toHaveLength(1);
  });
});
