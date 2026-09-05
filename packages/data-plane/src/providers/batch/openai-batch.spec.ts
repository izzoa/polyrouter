// add-batch-inference Phase C (tasks 6.1/6.2): golden-file contract tests for the
// OpenAI batch adapter against a stub implementing the FILES + BATCHES shape —
// what polyrouter uploads, that it streams rather than buffering or writing a
// temp file, and how it reads a partially-failed batch back from two files.
import { canonRequest, canonResponse, openaiAdapter } from '../../proxy/translate';
import { BatchUpstreamNotFoundError } from '../batch';
import { ProviderError } from '../errors';
import type { HttpInit, HttpResponse } from '../http';
import { createOpenaiProviderAdapter } from '../openai-adapter';
import { errorResponse, jsonResponse, recordingClient } from '../testkit.testkit';
import {
  OPENAI_BATCH_STATUSES,
  OPENAI_JOB_ID_KEY,
  OPENAI_STATUS_MAP,
  createOpenAiBatchAdapter,
  multipartJsonl,
  parseOpenAiBatch,
} from './openai-batch';
import submit from './golden/openai/submit.json';
import completed from './golden/openai/retrieve-completed.json';
import results from './golden/openai/results.json';
import list from './golden/openai/list.json';
import rejected from './golden/openai/rejected.json';

const CREDENTIAL = 'sk-proj-SECRET';
const config = {
  protocol: 'openai_compatible' as const,
  baseUrl: 'https://api.openai.com/v1',
  credential: CREDENTIAL,
  kind: 'api_key' as const,
  mode: 'cloud' as const,
  quirks: { maxTokensSpelling: 'max_tokens' as const },
};
const FILES = 'https://api.openai.com/v1/files';
const BATCHES = 'https://api.openai.com/v1/batches';

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

function jsonl(lines: readonly unknown[]): HttpResponse {
  return errorResponse(200, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', {
    'content-type': 'application/jsonl',
  });
}

/** A stub implementing the two-resource shape: the upload, then the batch. */
function build(responder: (url: string, init: HttpInit) => HttpResponse | Promise<HttpResponse>) {
  const { client, calls } = recordingClient(responder);
  const adapter = createOpenaiProviderAdapter(config, {
    httpClient: client,
    batch: createOpenAiBatchAdapter,
  });
  return { batch: adapter.batch!, calls };
}

const happyPath = (url: string): HttpResponse => {
  if (url === FILES) return jsonResponse(submit.file);
  if (url === BATCHES) return jsonResponse(submit.response);
  return errorResponse(404, '{}');
};

describe('OpenAI batch adapter — the file plane (task 6.1)', () => {
  it('uploads JSONL as a STREAMED multipart body, then creates the batch against the file id', async () => {
    const { batch, calls } = build(happyPath);
    const out = await batch.submit({ items, model: 'gpt-4o', jobId: 'job-1' });
    expect(calls).toHaveLength(2);

    const upload = calls[0]!;
    expect(upload.url).toBe(FILES);
    expect(upload.init.method).toBe('POST');
    expect(upload.init.headers['Authorization']).toBe(`Bearer ${CREDENTIAL}`);
    const ct = upload.init.headers['Content-Type']!;
    expect(ct).toMatch(/^multipart\/form-data; boundary=----polyrouterBatch[0-9a-f]{32}$/);
    // STREAMED, never a string: a 200 MB batch must not be materialized twice,
    // and nothing is written to local disk (D15).
    expect(typeof upload.init.body).not.toBe('string');
    const body = await drain(upload.init.body);
    const boundary = /boundary=(.+)$/.exec(ct)![1]!;
    expect(body.startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(body).toContain('name="purpose"\r\n\r\nbatch\r\n');
    expect(body).toContain('name="file"; filename="polyrouter-job-1.jsonl"');
    expect(body.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);

    // Each JSONL line is `{custom_id, method, url, body}` with the body in the
    // adapter's own wire shape — pinned canonically, not by string equality.
    const jsonlPart = body.slice(
      body.indexOf('application/jsonl\r\n\r\n') + 'application/jsonl\r\n\r\n'.length,
      body.lastIndexOf(`\r\n--${boundary}--`),
    );
    const lines = jsonlPart
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    lines.forEach((line, i) => {
      const golden = submit.inputLines[i]!;
      expect(line['custom_id']).toBe(golden.custom_id);
      expect(line['method']).toBe('POST');
      expect(line['url']).toBe('/v1/chat/completions');
      expect(canonRequest('openai', line['body'])).toEqual(canonRequest('openai', golden.body));
      expect((line['body'] as { model: string }).model).toBe('gpt-4o');
    });

    const create = calls[1]!;
    expect(create.url).toBe(BATCHES);
    expect(JSON.parse(create.init.body as string)).toEqual(submit.createRequest);
    expect(create.init.headers['Idempotency-Key']).toBe('job-1');
    expect(out).toEqual({
      upstreamId: 'batch_abc123',
      status: 'validating',
      completionWindowMs: 86_400_000,
      // No output expiry was requested, so the deadline is unknown — never invented.
      resultsExpireAt: null,
    });
  });

  it('composes the multipart envelope lazily: one line per pull, nothing accumulated', async () => {
    let produced = 0;
    const lines = (function* (): Generator<string> {
      for (let i = 0; i < 5; i += 1) {
        produced += 1;
        yield `{"i":${String(i)}}\n`;
      }
    })();
    const stream = multipartJsonl('BOUND', 'batch', 'f.jsonl', lines);
    const reader = stream.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('name="purpose"');
    await reader.read();
    // Incremental by construction: two chunks read, at most two lines produced —
    // the envelope is never assembled ahead of the consumer.
    expect(produced).toBeGreaterThan(0);
    expect(produced).toBeLessThan(5);
    await reader.cancel();
  });

  it('publishes the documented limits and declares no custom_id grammar', () => {
    const { batch } = build(happyPath);
    expect(batch.limits).toEqual({
      maxItems: 50_000,
      maxBytes: 200_000_000,
      customIdPattern: null,
      completionWindowMs: 86_400_000,
    });
  });

  it('surfaces a rejected create as a typed error with the credential scrubbed, and never uploads twice', async () => {
    const { batch, calls } = build((url) =>
      url === FILES
        ? jsonResponse(submit.file)
        : errorResponse(rejected.status, JSON.stringify(rejected.body)),
    );
    const err = await batch
      .submit({ items, model: 'gpt-4o', jobId: 'job-1' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('bad_request');
    expect((err as Error).message).not.toContain(CREDENTIAL);
    expect(calls.filter((c) => c.url === FILES)).toHaveLength(1);
  });

  it('a malformed file response fails before any batch is created', async () => {
    const { batch, calls } = build((url) =>
      url === FILES ? jsonResponse({ object: 'file' }) : jsonResponse(submit.response),
    );
    await expect(batch.submit({ items, model: 'gpt-4o', jobId: 'job-1' })).rejects.toMatchObject({
      kind: 'unavailable',
    });
    expect(calls.map((c) => c.url)).toEqual([FILES]);
  });
});

describe('OpenAI batch adapter — status, results, list, cancel (task 6.2)', () => {
  it('maps every documented status; anything else is null and never terminal', () => {
    for (const s of OPENAI_BATCH_STATUSES) expect(OPENAI_STATUS_MAP[s]).toBe(s);
    expect(OPENAI_BATCH_STATUSES).toHaveLength(8);
    expect(parseOpenAiBatch({ id: 'b', status: 'paused_for_review' }).status).toBeNull();
    expect(() => parseOpenAiBatch({ object: 'batch' })).toThrow(ProviderError);
  });

  it('reads counts from the batch and reports no retention deadline', async () => {
    const { batch, calls } = build(() => jsonResponse(completed));
    const view = await batch.status('batch_abc123');
    expect(calls[0]!.url).toBe(`${BATCHES}/batch_abc123`);
    expect(view).toEqual({
      status: 'completed',
      counts: { total: 3, completed: 2, failed: 1 },
      resultsExpireAt: null,
    });
  });

  it('settles a partially-failed batch from BOTH files, per item', async () => {
    const { batch, calls } = build((url) => {
      if (url === `${BATCHES}/batch_abc123`) return jsonResponse(completed);
      if (url === `${FILES}/file-out123/content`) return jsonl(results.output);
      if (url === `${FILES}/file-err123/content`) return jsonl(results.errors);
      return errorResponse(404, '{}');
    });
    const outcomes = [];
    for await (const o of batch.results('batch_abc123')) outcomes.push(o);
    expect(calls.map((c) => c.url)).toEqual([
      `${BATCHES}/batch_abc123`,
      `${FILES}/file-out123/content`,
      `${FILES}/file-err123/content`,
    ]);
    expect(outcomes).toHaveLength(3);
    const ok = outcomes[0]!;
    expect(ok).toMatchObject({ customId: 'req-1', ok: true, statusCode: 200 });
    if (ok.ok) {
      expect(ok.response.usage).toEqual({ inputTokens: 12, outputTokens: 9 });
      expect(canonResponse('openai', openaiAdapter.responseOut(ok.response))).toEqual(
        canonResponse('openai', results.output[0]!.response!.body),
      );
    }
    // A non-2xx line in the OUTPUT file is a failed item, classified by status.
    expect(outcomes[1]).toEqual({
      customId: 'req-2',
      ok: false,
      statusCode: 400,
      kind: 'bad_request',
    });
    // An ERROR-file line carries a code, not a status — only the code informs the
    // taxonomy, because the message may quote the item.
    expect(outcomes[2]).toEqual({
      customId: 'req-3',
      ok: false,
      statusCode: null,
      kind: 'rate_limit',
    });
    expect(JSON.stringify(outcomes)).not.toContain('Rate limit reached');
  });

  it('skips a file the batch does not have, and reads a batch with only failures', async () => {
    const { batch, calls } = build((url) => {
      if (url === `${BATCHES}/b1`) {
        return jsonResponse({
          ...completed,
          output_file_id: null,
          request_counts: { total: 1, completed: 0, failed: 1 },
        });
      }
      if (url === `${FILES}/file-err123/content`) return jsonl(results.errors);
      return errorResponse(404, '{}');
    });
    const outcomes = [];
    for await (const o of batch.results('b1')) outcomes.push(o);
    expect(outcomes.map((o) => o.customId)).toEqual(['req-3']);
    expect(calls.some((c) => c.url.includes('file-out'))).toBe(false);
  });

  it('lists with the job id echoed from metadata — the one upstream reconciliation can match by id', async () => {
    const { batch, calls } = build(() => jsonResponse(list));
    expect(await batch.list()).toEqual([
      { upstreamId: 'batch_abc123', jobId: 'job-1', status: 'in_progress' },
      { upstreamId: 'batch_nometa', jobId: null, status: 'completed' },
      { upstreamId: 'batch_novel', jobId: 'job-9', status: null },
    ]);
    expect(calls[0]!.url).toBe(`${BATCHES}?limit=100`);
    expect(OPENAI_JOB_ID_KEY).toBe('polyrouter_job_id');
  });

  it('cancels through the id route, and a 404 on status/results/cancel is not-found', async () => {
    const { batch, calls } = build((url) =>
      url.endsWith('/cancel')
        ? jsonResponse({ ...completed, status: 'cancelling' })
        : errorResponse(404, '{}'),
    );
    await batch.cancel('batch_abc123');
    expect(calls[0]!.url).toBe(`${BATCHES}/batch_abc123/cancel`);
    expect(calls[0]!.init.method).toBe('POST');
    await expect(batch.status('gone')).rejects.toBeInstanceOf(BatchUpstreamNotFoundError);
    await expect(
      (async () => {
        for await (const _ of batch.results('gone')) void _;
      })(),
    ).rejects.toBeInstanceOf(BatchUpstreamNotFoundError);
  });
});
