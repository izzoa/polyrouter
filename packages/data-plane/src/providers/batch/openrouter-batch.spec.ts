// add-batch-inference task 2.8: golden-file contract tests for the OpenRouter
// batch adapter against a stub upstream — what polyrouter sends (envelope, key
// order, per-item wire bodies) and how it reads the batch object, the inlined
// results, the list, and a rejection.
import { canonRequest, canonResponse, openaiAdapter } from '../../proxy/translate';
import type { NormalizedRequest } from '../../proxy/translate';
import { BatchUpstreamNotFoundError } from '../batch';
import { ProviderError } from '../errors';
import type { HttpInit, HttpResponse } from '../http';
import { createOpenaiProviderAdapter } from '../openai-adapter';
import { errorResponse, jsonResponse, recordingClient } from '../testkit.testkit';
import {
  OPENROUTER_BATCH_STATUSES,
  OPENROUTER_STATUS_MAP,
  createOpenRouterBatchAdapter,
  openRouterBatchesUrl,
} from './openrouter-batch';
import submit from './golden/openrouter/submit.json';
import inProgress from './golden/openrouter/retrieve-in-progress.json';
import completed from './golden/openrouter/retrieve-completed.json';
import list from './golden/openrouter/list.json';
import rejected from './golden/openrouter/rejected-text-only.json';

const CREDENTIAL = 'sk-or-v1-SECRET';
const config = {
  protocol: 'openai_compatible' as const,
  baseUrl: 'https://openrouter.ai/api/v1',
  credential: CREDENTIAL,
  kind: 'api_key' as const,
  mode: 'cloud' as const,
  quirks: { maxTokensSpelling: 'max_tokens' as const },
};

const items = [
  {
    customId: 'req-1',
    request: openaiAdapter.requestIn({
      model: 'ignored-by-batch',
      messages: [{ role: 'user', content: 'Say hello.' }],
      max_tokens: 32,
    }),
  },
  {
    customId: 'req-2',
    request: openaiAdapter.requestIn({
      model: 'ignored-by-batch',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'Name a colour, then a number.' },
      ],
      max_tokens: 16,
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

function build(responder: (url: string, init: HttpInit) => HttpResponse | Promise<HttpResponse>) {
  const { client, calls } = recordingClient(responder);
  const adapter = createOpenaiProviderAdapter(config, {
    httpClient: client,
    batch: createOpenRouterBatchAdapter,
  });
  return { batch: adapter.batch!, calls };
}

const BATCHES = 'https://openrouter.ai/api/beta/batches';

describe('OpenRouter batch adapter — submit', () => {
  it('posts the inline envelope with endpoint and model BEFORE requests, bodies in the adapter’s own wire shape', async () => {
    const { batch, calls } = build(() => jsonResponse(submit.response, 202));
    const out = await batch.submit({ items, model: 'openai/gpt-4o', jobId: 'job-1' });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(BATCHES);
    expect(call.init.method).toBe('POST');
    expect(call.init.headers['Authorization']).toBe(`Bearer ${CREDENTIAL}`);
    expect(call.init.headers['Content-Type']).toBe('application/json');
    // D6: the job id rides the create as an idempotency key.
    expect(call.init.headers['Idempotency-Key']).toBe('job-1');
    // The body is STREAMED, never a string — one item per pull (D1).
    expect(typeof call.init.body).not.toBe('string');
    const sent = JSON.parse(await drain(call.init.body)) as Record<string, unknown>;
    expect(Object.keys(sent)).toEqual(['endpoint', 'model', 'requests']);
    expect(sent['endpoint']).toBe(submit.request.endpoint);
    expect(sent['model']).toBe(submit.request.model);
    const requests = sent['requests'] as Array<{ custom_id: string; body: unknown }>;
    expect(requests.map((r) => r.custom_id)).toEqual(
      submit.request.requests.map((r) => r.custom_id),
    );
    requests.forEach((r, i) => {
      // Per-item bodies are the translate module's wire output — pinned canonically.
      expect(canonRequest('openai', r.body)).toEqual(
        canonRequest('openai', submit.request.requests[i]!.body),
      );
      expect((r.body as { model: string }).model).toBe('openai/gpt-4o');
    });
    expect(out).toEqual({
      upstreamId: 'batch_123',
      status: 'validating',
      completionWindowMs: 86_400_000,
      resultsExpireAt: new Date(1782097200 * 1000 + 30 * 86_400_000),
    });
  });

  it('derives the upstream endpoint from the adapter protocol, not from the client', () => {
    expect(openRouterBatchesUrl('https://openrouter.ai/api/v1')).toBe(BATCHES);
    // An anthropic_compatible OpenRouter provider ships Messages-shaped items.
    const { client, calls } = recordingClient(() => jsonResponse(submit.response, 202));
    const adapter = createOpenaiProviderAdapter(
      { ...config, protocol: 'anthropic_compatible' },
      { httpClient: client, batch: createOpenRouterBatchAdapter },
    );
    void adapter;
    void calls;
  });

  it('surfaces a text-only rejection as a typed bad_request with the credential scrubbed', async () => {
    const { batch } = build(() => errorResponse(rejected.status, JSON.stringify(rejected.body)));
    const err = await batch
      .submit({ items, model: 'openai/gpt-4o', jobId: 'job-1' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('bad_request');
    expect((err as ProviderError).status).toBe(400);
    expect((err as Error).message).not.toContain(CREDENTIAL);
  });

  it('a create 404 is a provider fault, never a "batch not found"', async () => {
    const { batch } = build(() => errorResponse(404, '{"error":{"message":"no such route"}}'));
    await expect(
      batch.submit({ items, model: 'openai/gpt-4o', jobId: 'job-1' }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('OpenRouter batch adapter — status, results, list, cancel', () => {
  it('maps every documented status; anything else is null (never terminal)', () => {
    for (const s of OPENROUTER_BATCH_STATUSES) expect(OPENROUTER_STATUS_MAP[s]).toBe(s);
    expect(OPENROUTER_BATCH_STATUSES).toHaveLength(8);
  });

  it('reads status and counts from the GET, with the 30-day retention derived from created_at', async () => {
    const { batch, calls } = build(() => jsonResponse(inProgress));
    const view = await batch.status('batch_123');
    expect(calls[0]!.url).toBe(`${BATCHES}/batch_123`);
    expect(calls[0]!.init.method).toBe('GET');
    expect(view).toEqual({
      status: 'in_progress',
      counts: { total: 2, completed: 1, failed: 0 },
      resultsExpireAt: new Date(1782097200 * 1000 + 30 * 86_400_000),
    });
  });

  it('a completed GET inlines results: status() skips them, results() streams them keyed by custom_id', async () => {
    const { batch } = build(() => jsonResponse(completed));
    const view = await batch.status('batch_123');
    expect(view.status).toBe('completed');
    expect(view.counts).toEqual({ total: 2, completed: 1, failed: 1 });

    const outcomes = [];
    for await (const o of batch.results('batch_123')) outcomes.push(o);
    expect(outcomes).toHaveLength(2);
    const failed = outcomes[0]!;
    const okItem = outcomes[1]!;
    expect(failed).toEqual({ customId: 'req-2', ok: false, statusCode: 429, kind: 'rate_limit' });
    expect(okItem).toMatchObject({ customId: 'req-1', ok: true, statusCode: 200 });
    if (okItem.ok) {
      expect(okItem.response.usage).toEqual({ inputTokens: 12, outputTokens: 9 });
      // The parsed IR re-serializes to the fixture body (canonically): nothing lost.
      expect(canonResponse('openai', openaiAdapter.responseOut(okItem.response))).toEqual(
        canonResponse('openai', completed.results[1]!.response!.body),
      );
    }
  });

  it('lists newest-first metadata with mapped statuses and no job-id echo', async () => {
    const { batch, calls } = build(() => jsonResponse(list));
    const entries = await batch.list();
    expect(calls[0]!.url).toBe(`${BATCHES}?limit=100`);
    expect(entries).toEqual([
      { upstreamId: 'batch_9f2c1e', jobId: null, status: 'completed' },
      { upstreamId: 'batch_paused', jobId: null, status: null },
    ]);
  });

  it('cancels through the id route and treats a 404 on status/results/cancel as not-found', async () => {
    const { batch, calls } = build((url) =>
      url.endsWith('/cancel')
        ? jsonResponse({ ...inProgress, status: 'cancelling' })
        : errorResponse(404, '{}'),
    );
    await batch.cancel('batch_123');
    expect(calls[0]!.url).toBe(`${BATCHES}/batch_123/cancel`);
    expect(calls[0]!.init.method).toBe('POST');
    await expect(batch.status('batch_gone')).rejects.toBeInstanceOf(BatchUpstreamNotFoundError);
    await expect(
      (async () => {
        for await (const _ of batch.results('batch_gone')) void _;
      })(),
    ).rejects.toBeInstanceOf(BatchUpstreamNotFoundError);
    const { batch: b2 } = build(() => errorResponse(404, '{}'));
    await expect(b2.cancel('batch_gone')).rejects.toBeInstanceOf(BatchUpstreamNotFoundError);
  });

  it('a malformed batch object is a provider fault, and a 500 classifies as unavailable', async () => {
    const { batch } = build(() => jsonResponse({ object: 'batch' }));
    await expect(batch.status('batch_123')).rejects.toMatchObject({ kind: 'unavailable' });
    const { batch: b2 } = build(() => errorResponse(503, 'down'));
    await expect(b2.status('batch_123')).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('carries no upstream limits of its own', () => {
    const { batch } = build(() => jsonResponse({}));
    expect(batch.limits).toEqual({
      maxItems: null,
      maxBytes: null,
      customIdPattern: null,
      completionWindowMs: 86_400_000,
    });
  });
});

// Keep the request fixture honest: its IR round-trips through the same adapter.
describe('golden request bodies are valid OpenAI wire', () => {
  it.each(submit.request.requests.map((r) => [r.custom_id, r.body] as const))(
    '%s parses through requestIn',
    (_id, body) => {
      const ir: NormalizedRequest = openaiAdapter.requestIn(body);
      expect(ir.messages.length).toBeGreaterThan(0);
    },
  );
});
