// add-batch-inference task 2.9: golden-file contract tests for the Anthropic
// Message Batches adapter against a stub upstream — including a partially
// failed batch settled per item, and the results path pinned to the configured
// origin rather than an echoed results_url.
import { anthropicAdapter, canonRequest, canonResponse } from '../../proxy/translate';
import { createAnthropicProviderAdapter } from '../anthropic-adapter';
import { BatchUpstreamNotFoundError } from '../batch';
import { ProviderError } from '../errors';
import type { HttpInit, HttpResponse } from '../http';
import { errorResponse, jsonResponse, recordingClient } from '../testkit.testkit';
import {
  ANTHROPIC_CUSTOM_ID,
  ANTHROPIC_PROCESSING_STATUSES,
  anthropicErrorKind,
  createAnthropicBatchAdapter,
  mapAnthropicStatus,
  parseMessageBatch,
} from './anthropic-batch';
import create from './golden/anthropic/create.json';
import ended from './golden/anthropic/retrieve-ended.json';
import results from './golden/anthropic/results.json';
import list from './golden/anthropic/list.json';
import rejected from './golden/anthropic/rejected.json';

const CREDENTIAL = 'sk-ant-api03-SECRET';
const config = {
  protocol: 'anthropic_compatible' as const,
  baseUrl: 'https://api.anthropic.com',
  credential: CREDENTIAL,
  kind: 'api_key' as const,
  mode: 'cloud' as const,
  defaultMaxOutputTokens: 4096,
};
const BATCHES = 'https://api.anthropic.com/v1/messages/batches';

const items = [
  {
    customId: 'req-1',
    request: anthropicAdapter.requestIn({
      model: 'ignored-by-batch',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Say hello.' }],
    }),
  },
  {
    customId: 'req_2',
    request: anthropicAdapter.requestIn({
      model: 'ignored-by-batch',
      max_tokens: 16,
      system: 'Be terse.',
      messages: [{ role: 'user', content: 'Name a colour, then a number.' }],
      temperature: 0.2,
    }),
  },
] as const;

async function drain(body: HttpInit['body']): Promise<string> {
  if (body === undefined) return '';
  if (typeof body === 'string') return body;
  const reader = body.getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out + dec.decode();
}

function jsonl(lines: readonly unknown[]): HttpResponse {
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  return errorResponse(200, text, { 'content-type': 'application/x-jsonl' });
}

function build(responder: (url: string, init: HttpInit) => HttpResponse | Promise<HttpResponse>) {
  const { client, calls } = recordingClient(responder);
  const adapter = createAnthropicProviderAdapter(config, {
    httpClient: client,
    batch: createAnthropicBatchAdapter,
  });
  return { batch: adapter.batch!, calls };
}

describe('Anthropic batch adapter — create', () => {
  it('posts requests[{custom_id, params}] with the adapter’s auth headers and Messages-shaped params', async () => {
    const { batch, calls } = build(() => jsonResponse(create.response));
    const out = await batch.submit({ items, model: 'claude-sonnet-4-5', jobId: 'job-1' });
    const call = calls[0]!;
    expect(call.url).toBe(BATCHES);
    expect(call.init.method).toBe('POST');
    expect(call.init.headers['x-api-key']).toBe(CREDENTIAL);
    expect(call.init.headers['anthropic-version']).toBe('2023-06-01');
    // D6: the job id rides the create as an idempotency key.
    expect(call.init.headers['Idempotency-Key']).toBe('job-1');
    expect(typeof call.init.body).not.toBe('string'); // streamed
    const sent = JSON.parse(await drain(call.init.body)) as {
      requests: Array<{ custom_id: string; params: unknown }>;
    };
    expect(Object.keys(sent)).toEqual(['requests']);
    expect(sent.requests.map((r) => r.custom_id)).toEqual(
      create.request.requests.map((r) => r.custom_id),
    );
    sent.requests.forEach((r, i) => {
      expect(canonRequest('anthropic', r.params)).toEqual(
        canonRequest('anthropic', create.request.requests[i]!.params),
      );
      expect((r.params as { model: string; max_tokens: number }).model).toBe('claude-sonnet-4-5');
      expect((r.params as { max_tokens: number }).max_tokens).toBeGreaterThan(0);
    });
    expect(out).toEqual({
      upstreamId: 'msgbatch_013Zva2CMHLNnXjNJJKqJ2EF',
      status: 'in_progress',
      completionWindowMs: 86_400_000,
      resultsExpireAt: new Date(Date.parse('2026-09-05T18:37:24.100435Z') + 29 * 86_400_000),
    });
  });

  it('surfaces a rejected create as a typed bad_request without the credential', async () => {
    const { batch } = build(() => errorResponse(rejected.status, JSON.stringify(rejected.body)));
    const err = await batch
      .submit({ items, model: 'claude-sonnet-4-5', jobId: 'job-1' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('bad_request');
    expect((err as Error).message).not.toContain(CREDENTIAL);
  });

  it('publishes the documented limits, including the custom_id grammar', () => {
    const { batch } = build(() => jsonResponse({}));
    expect(batch.limits).toEqual({
      maxItems: 100_000,
      maxBytes: 256_000_000,
      customIdPattern: ANTHROPIC_CUSTOM_ID,
      completionWindowMs: 86_400_000,
    });
    expect(ANTHROPIC_CUSTOM_ID.test('req_2')).toBe(true);
    expect(ANTHROPIC_CUSTOM_ID.test('a'.repeat(64))).toBe(true);
    expect(ANTHROPIC_CUSTOM_ID.test('a'.repeat(65))).toBe(false);
    expect(ANTHROPIC_CUSTOM_ID.test('has space')).toBe(false);
    expect(ANTHROPIC_CUSTOM_ID.test('')).toBe(false);
  });
});

describe('Anthropic batch adapter — status mapping', () => {
  const counts = (
    over: Partial<Record<'processing' | 'succeeded' | 'errored' | 'canceled' | 'expired', number>>,
  ) => ({
    processing: 0,
    succeeded: 0,
    errored: 0,
    canceled: 0,
    expired: 0,
    ...over,
  });

  it('is total over the documented enum and null beyond it', () => {
    expect(ANTHROPIC_PROCESSING_STATUSES).toEqual(['in_progress', 'canceling', 'ended']);
    expect(mapAnthropicStatus('in_progress', counts({ processing: 3 }), false)).toBe('in_progress');
    expect(mapAnthropicStatus('canceling', counts({ processing: 3 }), true)).toBe('cancelling');
    expect(mapAnthropicStatus('paused', counts({}), false)).toBeNull();
    expect(mapAnthropicStatus(undefined, null, false)).toBeNull();
  });

  it('resolves `ended` through the tallies: cancelled, expired wholesale, else completed (partial included)', () => {
    expect(mapAnthropicStatus('ended', counts({ succeeded: 40, canceled: 60 }), true)).toBe(
      'cancelled',
    );
    expect(mapAnthropicStatus('ended', counts({ succeeded: 1 }), true)).toBe('cancelled'); // cancel initiated, nothing interruptible
    expect(mapAnthropicStatus('ended', counts({ expired: 7 }), false)).toBe('expired');
    expect(
      mapAnthropicStatus('ended', counts({ succeeded: 1, errored: 1, expired: 1 }), false),
    ).toBe('completed');
    expect(mapAnthropicStatus('ended', null, false)).toBe('completed');
  });

  it('parses the retrieve object into counts and retention', () => {
    const meta = parseMessageBatch(ended);
    expect(meta).toEqual({
      id: 'msgbatch_013Zva2CMHLNnXjNJJKqJ2EF',
      status: 'completed',
      counts: { total: 3, completed: 1, failed: 1 },
      resultsExpireAt: new Date(Date.parse('2026-09-05T18:37:24.100435Z') + 29 * 86_400_000),
    });
    // The archive stamp, once present, is authoritative.
    expect(parseMessageBatch(list.data[2]).resultsExpireAt).toEqual(
      new Date('2026-10-03T15:00:00.000000Z'),
    );
    expect(() => parseMessageBatch({ type: 'message_batch' })).toThrow(ProviderError);
  });

  it('maps per-item error types onto the taxonomy, unknown types to upstream_rejected', () => {
    expect(anthropicErrorKind('rate_limit_error')).toBe('rate_limit');
    expect(anthropicErrorKind('invalid_request_error')).toBe('bad_request');
    expect(anthropicErrorKind('billing_error')).toBe('insufficient_funds');
    expect(anthropicErrorKind('overloaded_error')).toBe('unavailable');
    expect(anthropicErrorKind('brand_new_error')).toBe('upstream_rejected');
    expect(anthropicErrorKind(undefined)).toBe('upstream_rejected');
  });
});

describe('Anthropic batch adapter — status, results, list, cancel', () => {
  it('reads the batch by its own path and settles a partially failed batch per item, skipping what never ran', async () => {
    const { batch, calls } = build((url) =>
      url.endsWith('/results') ? jsonl(results.lines) : jsonResponse(ended),
    );
    const view = await batch.status('msgbatch_013Zva2CMHLNnXjNJJKqJ2EF');
    expect(calls[0]!.url).toBe(`${BATCHES}/msgbatch_013Zva2CMHLNnXjNJJKqJ2EF`);
    expect(view).toEqual({
      status: 'completed',
      counts: { total: 3, completed: 1, failed: 1 },
      resultsExpireAt: new Date(Date.parse('2026-09-05T18:37:24.100435Z') + 29 * 86_400_000),
    });

    const outcomes = [];
    for await (const o of batch.results('msgbatch_013Zva2CMHLNnXjNJJKqJ2EF')) outcomes.push(o);
    // The results path is the batch's OWN, never the echoed (foreign) results_url.
    expect(calls[1]!.url).toBe(`${BATCHES}/msgbatch_013Zva2CMHLNnXjNJJKqJ2EF/results`);
    expect(calls[1]!.init.headers['x-api-key']).toBe(CREDENTIAL);
    expect(outcomes).toHaveLength(2); // the expired line is not an outcome
    expect(outcomes[0]).toEqual({
      customId: 'req_2',
      ok: false,
      statusCode: null,
      kind: 'rate_limit',
    });
    expect(outcomes[1]).toMatchObject({ customId: 'req-1', ok: true, statusCode: 200 });
    if (outcomes[1]!.ok) {
      expect(outcomes[1]!.response.usage).toEqual({
        inputTokens: 11,
        outputTokens: 12,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      expect(
        canonResponse('anthropic', anthropicAdapter.responseOut(outcomes[1]!.response)),
      ).toEqual(canonResponse('anthropic', results.lines[2]!.result.message));
    }
  });

  it('lists with mapped statuses and no job-id echo; cancels via /cancel; 404 is not-found', async () => {
    const { batch, calls } = build((url) => {
      if (url.endsWith('?limit=100')) return jsonResponse(list);
      if (url.endsWith('/cancel'))
        return jsonResponse({
          ...ended,
          processing_status: 'canceling',
          cancel_initiated_at: '2026-09-05T19:00:00Z',
        });
      return errorResponse(
        404,
        JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'nope' } }),
      );
    });
    expect(await batch.list()).toEqual([
      { upstreamId: 'msgbatch_canceling', jobId: null, status: 'cancelling' },
      { upstreamId: 'msgbatch_cancelled', jobId: null, status: 'cancelled' },
      { upstreamId: 'msgbatch_expired', jobId: null, status: 'expired' },
      { upstreamId: 'msgbatch_novel', jobId: null, status: null },
    ]);
    expect(calls[0]!.url).toBe(`${BATCHES}?limit=100`);
    await batch.cancel('msgbatch_x');
    expect(calls[1]!.url).toBe(`${BATCHES}/msgbatch_x/cancel`);
    expect(calls[1]!.init.method).toBe('POST');
    await expect(batch.status('msgbatch_gone')).rejects.toBeInstanceOf(BatchUpstreamNotFoundError);
    await expect(
      (async () => {
        for await (const _ of batch.results('msgbatch_gone')) void _;
      })(),
    ).rejects.toBeInstanceOf(BatchUpstreamNotFoundError);
  });

  it('a malformed results line is a typed failure, and a 529 overload classifies as unavailable', async () => {
    const { batch } = build(() =>
      errorResponse(200, '{"custom_id":"a","result":{"type":"succeeded","message":{}}}\n{broken\n'),
    );
    await expect(
      (async () => {
        for await (const _ of batch.results('msgbatch_1')) void _;
      })(),
    ).rejects.toMatchObject({ reason: 'malformed' });
    const { batch: b2 } = build(() =>
      errorResponse(
        529,
        '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      ),
    );
    await expect(b2.status('msgbatch_1')).rejects.toMatchObject({ kind: 'unavailable' });
  });
});
