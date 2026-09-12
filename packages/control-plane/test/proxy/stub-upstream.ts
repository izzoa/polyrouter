// A local stub upstream speaking OpenAI + Anthropic wire (JSON + SSE), used by
// the proxy e2e. Behavior is switched by the (retargeted) model name so tests
// can drive error modes: `*miderror*` fails after a token, `*firsterror*` fails
// as the first event. Bound to 127.0.0.1 so a `local` provider passes the SSRF
// gate under MODE=selfhosted.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface StubRequestRecord {
  path: string;
  auth: string | undefined;
  xApiKey: string | undefined;
  /** Settles when this request/response pair is torn down — the response ended
   * normally OR the proxy aborted the upstream call (stream-lifecycle e2e). */
  closed: Promise<void>;
}

export interface StubUpstream {
  readonly url: string;
  readonly requests: StubRequestRecord[];
  /** The stub's batch jobs by upstream id (add-batch-inference e2e). */
  readonly batches: Map<string, StubBatch>;
  /** SSE frames fully handed to the socket by the `bigframes` model. The writer
   * is drain-aware (awaits `res.write() === false` → `'drain'`), so this counter
   * is a sound observable of end-to-end backpressure: it stalls when the proxy
   * stops pulling because ITS client stopped reading. */
  /** Result JSONL lines fully handed to the socket by a batch whose upstream id
   * contains `bigresults`. Written drain-aware, so this counter stalls when the
   * proxy stops pulling because ITS client stopped reading. */
  resultLinesSent(): number;
  framesSent(): number;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

const sse = (res: ServerResponse): void => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
};

function openaiJson(res: ServerResponse, model: string): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  // `*empty*` → an empty answer (a cascade quality failure → escalate, #14).
  const content = model.includes('empty') ? '' : 'Hello from stub';
  // `*lenstop*` → a token-cap truncation (finish_reason 'length') — the 0.5
  // quality grade (harden-cascade-quality-gate).
  const finish = model.includes('lenstop') ? 'length' : 'stop';
  res.end(
    JSON.stringify({
      id: 'chatcmpl-stub',
      object: 'chat.completion',
      created: 1,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
  );
}

function anthropicJson(res: ServerResponse, model: string): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: 'msg_stub',
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: 'Hello from stub' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 2 },
    }),
  );
}

function anthropicStream(res: ServerResponse, model: string): void {
  sse(res);
  const frame = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  if (model.includes('firsterror')) {
    frame('error', { type: 'error', error: { type: 'overloaded_error', message: 'SECRET first' } });
    res.end();
    return;
  }
  frame('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_stub',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 3, output_tokens: 0 },
    },
  });
  frame('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  frame('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Hello' },
  });
  if (model.includes('miderror')) {
    frame('error', { type: 'error', error: { type: 'overloaded_error', message: 'SECRET mid' } });
    res.end();
    return;
  }
  frame('content_block_stop', { type: 'content_block_stop', index: 0 });
  frame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 2 },
  });
  frame('message_stop', { type: 'message_stop' });
  res.end();
}

function openaiStream(res: ServerResponse, model: string): void {
  sse(res);
  const chunk = (choices: unknown[]): void => {
    res.write(
      `data: ${JSON.stringify({ id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: 1, model, choices })}\n\n`,
    );
  };
  chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);
  chunk([{ index: 0, delta: { content: 'Hello' }, finish_reason: null }]);
  if (model.includes('miderror')) {
    res.write(
      `data: ${JSON.stringify({ error: { message: 'SECRET mid', type: 'server_error' } })}\n\n`,
    );
    res.end();
    return;
  }
  // `*neverend*` → commit (role + one token) then hold the stream open forever;
  // only an upstream abort (drain deadline, client disconnect) ends it.
  if (model.includes('neverend')) return;
  // `*slowtail*` → commit immediately, then finish after a delay — an
  // "in-flight" stream the lifecycle e2e can drain/disconnect deterministically.
  if (model.includes('slowtail')) {
    setTimeout(() => {
      if (res.writableEnded || res.destroyed) return;
      chunk([{ index: 0, delta: { content: ' tail' }, finish_reason: null }]);
      chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]);
      res.write('data: [DONE]\n\n');
      res.end();
    }, 400);
    return;
  }
  chunk([{ index: 0, delta: {}, finish_reason: model.includes('lenstop') ? 'length' : 'stop' }]);
  res.write('data: [DONE]\n\n');
  res.end();
}

/** `*bigframes*` → many large SSE frames, written drain-aware so `onFrame`
 * fires only when a frame has genuinely left for the socket (not parked in an
 * unbounded local buffer). Each content marker is `<i>:<64KiB pad>` so the
 * client can assert complete, ordered delivery. */
export const BIG_FRAME_COUNT = 120;
const BIG_FRAME_PAD = 'x'.repeat(64 * 1024);

function openaiStreamBigFrames(res: ServerResponse, model: string, onFrame: () => void): void {
  sse(res);
  const write = (payload: string): Promise<void> =>
    new Promise((resolve) => {
      if (res.destroyed || res.writableEnded) return resolve();
      if (res.write(payload)) return resolve();
      const done = (): void => {
        res.off('drain', done);
        res.off('close', done);
        res.off('error', done);
        resolve();
      };
      res.once('drain', done);
      res.once('close', done);
      res.once('error', done);
    });
  const chunk = (choices: unknown[]): string =>
    `data: ${JSON.stringify({ id: 'chatcmpl-stub', object: 'chat.completion.chunk', created: 1, model, choices })}\n\n`;
  void (async () => {
    await write(chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]));
    for (let i = 0; i < BIG_FRAME_COUNT; i++) {
      if (res.destroyed || res.writableEnded) return;
      await write(
        chunk([{ index: 0, delta: { content: `${i}:${BIG_FRAME_PAD};` }, finish_reason: null }]),
      );
      onFrame();
    }
    await write(chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]));
    await write('data: [DONE]\n\n');
    if (!res.writableEnded && !res.destroyed) res.end();
  })();
}

/** An upstream batch job the stub holds (add-batch-inference e2e). Shaped like
 * OpenRouter's object; the Anthropic routes render the same record in Message
 * Batch shape. Tests drive status/results through `stub.batches`. */
export interface StubBatch {
  id: string;
  model: string;
  endpoint: string;
  status: string;
  created_at: number;
  requests: { custom_id: string; body: Record<string, unknown> }[];
  /** Results in OpenRouter's result-item shape; the Anthropic routes translate. */
  results: StubBatchResult[] | null;
  cancel_initiated: boolean;
  /** polyrouter's job id, echoed by the upstreams that carry metadata (OpenAI). */
  jobId?: string | null;
}

export interface StubBatchResult {
  custom_id: string;
  response: { status_code: number; body: Record<string, unknown> } | null;
  error: { code: number; message: string } | null;
}

function openRouterBatchObject(b: StubBatch, withResults: boolean): Record<string, unknown> {
  const completed = b.results?.filter((r) => r.response !== null).length ?? 0;
  const failed = b.results?.filter((r) => r.error !== null).length ?? 0;
  return {
    id: b.id,
    object: 'batch',
    endpoint: b.endpoint,
    model: b.model,
    completion_window: '24h',
    status: b.status,
    created_at: b.created_at,
    finalized_at: b.status === 'completed' ? b.created_at + 60 : null,
    request_counts: { total: b.requests.length, completed, failed },
    usage: null,
    results: withResults && b.status === 'completed' ? b.results : null,
    error: null,
  };
}

function anthropicBatchObject(b: StubBatch): Record<string, unknown> {
  const succeeded = b.results?.filter((r) => r.response !== null).length ?? 0;
  const errored = b.results?.filter((r) => r.error !== null).length ?? 0;
  const ended = ['completed', 'failed', 'expired', 'cancelled'].includes(b.status);
  const processing = ended
    ? Math.max(0, b.requests.length - succeeded - errored)
    : b.requests.length;
  return {
    id: b.id,
    type: 'message_batch',
    processing_status: b.status === 'cancelling' ? 'canceling' : ended ? 'ended' : 'in_progress',
    request_counts: {
      processing: ended ? 0 : processing,
      succeeded,
      errored,
      canceled: b.status === 'cancelled' ? processing : 0,
      expired: b.status === 'expired' ? processing : 0,
    },
    ended_at: ended ? new Date((b.created_at + 60) * 1000).toISOString() : null,
    created_at: new Date(b.created_at * 1000).toISOString(),
    expires_at: new Date((b.created_at + 86_400) * 1000).toISOString(),
    archived_at: null,
    cancel_initiated_at: b.cancel_initiated
      ? new Date((b.created_at + 30) * 1000).toISOString()
      : null,
    results_url: ended ? `/v1/messages/batches/${b.id}/results` : null,
  };
}

/** A deterministic completion for a stub batch: every request succeeds with a
 * small completion (OpenAI or Anthropic wire per the item shape) and fixed usage,
 * except `custom_id`s containing `fail`, which error. */
export function completeStubBatch(b: StubBatch, over: Partial<StubBatch> = {}): void {
  b.results = b.requests.map((r, i) => {
    if (r.custom_id.includes('fail')) {
      return {
        custom_id: r.custom_id,
        response: null,
        error: { code: 429, message: 'stub rate limited' },
      };
    }
    const anthropicShaped = b.endpoint === '/v1/messages';
    const body: Record<string, unknown> = anthropicShaped
      ? {
          id: `msg_stub_${String(i)}`,
          type: 'message',
          role: 'assistant',
          model: b.model,
          content: [{ type: 'text', text: `Hello ${r.custom_id}` }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 3 },
        }
      : {
          id: `gen-batch-${String(i)}`,
          object: 'chat.completion',
          created: b.created_at,
          model: b.model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: `Hello ${r.custom_id}` },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        };
    return { custom_id: r.custom_id, response: { status_code: 200, body }, error: null };
  });
  b.status = 'completed';
  Object.assign(b, over);
}

const pathOnlyOf = (path: string): string => path.split('?')[0]!;

/** Extract the JSONL payload from the streamed multipart envelope polyrouter
 * uploads — the stub's half of the file plane, and proof the parts arrived. */
function jsonlFromMultipart(body: string): string {
  const marker = 'application/jsonl\r\n\r\n';
  const start = body.indexOf(marker);
  if (start === -1) return '';
  const rest = body.slice(start + marker.length);
  const end = rest.lastIndexOf('\r\n--');
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

/**
 * OpenAI's files + batches shape (Phase C). Returns true when it handled the
 * request. `*batchreject*` in a model refuses the CREATE; a batch whose id
 * contains `oaifail` returns a 500 on the create instead.
 */
function serveOpenAiBatch(
  pathOnly: string,
  method: string,
  raw: string,
  res: ServerResponse,
  ctx: {
    batches: Map<string, StubBatch>;
    files: Map<string, string>;
    nextId: () => number;
  },
): boolean {
  const json = (status: number, payload: unknown): true => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
    return true;
  };
  const object = (b: StubBatch): Record<string, unknown> => {
    const completed = b.results?.filter((r) => r.response !== null).length ?? 0;
    const failed = b.results?.filter((r) => r.error !== null).length ?? 0;
    return {
      id: b.id,
      object: 'batch',
      endpoint: b.endpoint,
      input_file_id: `file-in-${b.id}`,
      completion_window: '24h',
      status: b.status,
      output_file_id: b.status === 'completed' ? `file-out-${b.id}` : null,
      error_file_id: b.status === 'completed' && failed > 0 ? `file-err-${b.id}` : null,
      created_at: b.created_at,
      request_counts: { total: b.requests.length, completed, failed },
      metadata: b.jobId !== null ? { polyrouter_job_id: b.jobId } : null,
    };
  };

  if (pathOnly === '/oai/files' && method === 'POST') {
    const jsonl = jsonlFromMultipart(raw);
    const id = `file-in-${String(ctx.nextId())}`;
    ctx.files.set(id, jsonl);
    return json(200, { id, object: 'file', bytes: jsonl.length, purpose: 'batch' });
  }
  if (pathOnly === '/oai/batches' && method === 'POST') {
    const doc = raw
      ? (JSON.parse(raw) as {
          input_file_id?: string;
          endpoint?: string;
          metadata?: Record<string, string>;
        })
      : {};
    const jsonl = ctx.files.get(doc.input_file_id ?? '') ?? '';
    const requests = jsonl
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { custom_id: string; body: Record<string, unknown> })
      .map((l) => ({ custom_id: l.custom_id, body: l.body }));
    const model = (requests[0]?.body['model'] as string | undefined) ?? '';
    if (model.includes('batchreject')) {
      return json(400, {
        error: { message: 'stub refused the batch', type: 'invalid_request_error' },
      });
    }
    const b: StubBatch = {
      id: `batch_oai_${String(ctx.nextId())}`,
      model,
      endpoint: doc.endpoint ?? '/v1/chat/completions',
      status: 'validating',
      created_at: Math.floor(Date.now() / 1000),
      requests,
      results: null,
      cancel_initiated: false,
      jobId: doc.metadata?.['polyrouter_job_id'] ?? null,
    };
    ctx.batches.set(b.id, b);
    return json(200, object(b));
  }
  if (pathOnly === '/oai/batches' && method === 'GET') {
    return json(200, {
      object: 'list',
      data: [...ctx.batches.values()]
        .filter((b) => b.id.startsWith('batch_oai_'))
        .reverse()
        .map(object),
      first_id: null,
      last_id: null,
      has_more: false,
    });
  }
  const file = /^\/oai\/files\/(file-(?:out|err)-[^/]+)\/content$/.exec(pathOnly);
  if (file !== null && method === 'GET') {
    const id = file[1]!;
    const wantErrors = id.startsWith('file-err-');
    const b = ctx.batches.get(id.replace(/^file-(?:out|err)-/, ''));
    if (b === undefined || b.results === null)
      return json(404, { error: { message: 'no such file' } });
    const lines = b.results
      .filter((r) => (wantErrors ? r.error !== null : r.response !== null))
      .map((r) =>
        r.response !== null
          ? {
              id: `batch_req_${r.custom_id}`,
              custom_id: r.custom_id,
              response: {
                status_code: r.response.status_code,
                request_id: 'req_x',
                body: r.response.body,
              },
              error: null,
            }
          : {
              id: `batch_req_${r.custom_id}`,
              custom_id: r.custom_id,
              response: null,
              error: { code: 'rate_limit_exceeded', message: r.error?.message ?? '' },
            },
      );
    res.writeHead(200, { 'content-type': 'application/jsonl' });
    res.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return true;
  }
  const one = /^\/oai\/batches\/([^/]+)(?:\/(cancel))?$/.exec(pathOnly);
  if (one !== null) {
    const b = ctx.batches.get(one[1]!);
    if (b === undefined) return json(404, { error: { message: 'batch not found' } });
    if (one[2] === 'cancel' && method === 'POST') {
      b.cancel_initiated = true;
      if (!['completed', 'failed', 'expired', 'cancelled'].includes(b.status))
        b.status = 'cancelling';
      return json(200, object(b));
    }
    return json(200, object(b));
  }
  return false;
}

export async function startStubUpstream(): Promise<StubUpstream> {
  const requests: StubUpstream['requests'] = [];
  const batches = new Map<string, StubBatch>();
  const openAiFiles = new Map<string, string>();
  let batchSeq = 0;
  let resultLinesSent = 0;
  let bigFramesSent = 0;
  // Track live sockets so close() can sever deliberately-open connections
  // (`neverend`, paused `bigframes` readers) instead of hanging on them.
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = req.url ?? '';
      const raw = await readBody(req);
      // Tolerant: the OpenAI file plane uploads a MULTIPART body, which is not
      // JSON. Throwing here would leave the request hanging with no response.
      let body: { model?: string; stream?: boolean } = {};
      if (raw) {
        try {
          body = JSON.parse(raw) as { model?: string; stream?: boolean };
        } catch {
          body = {};
        }
      }
      const model = body.model ?? '';
      const stream = body.stream === true;
      requests.push({
        path,
        auth: req.headers.authorization,
        xApiKey:
          typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined,
        closed: new Promise<void>((resolve) => res.once('close', resolve)),
      });
      // --- OpenAI's FILE plane (add-batch-inference Phase C) -----------------
      // Mounted under `/oai` so one stub can serve all three upstream shapes.
      if (pathOnlyOf(path).startsWith('/oai/')) {
        const handled = serveOpenAiBatch(pathOnlyOf(path), req.method ?? 'GET', raw, res, {
          batches,
          files: openAiFiles,
          nextId: () => {
            batchSeq += 1;
            return batchSeq;
          },
        });
        if (handled) return;
      }
      // --- batch routes (add-batch-inference e2e) ---------------------------
      const json = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const pathOnly = pathOnlyOf(path);
      const orBatch = /\/api\/beta\/batches(?:\/([^/]+))?(?:\/(cancel))?$/.exec(pathOnly);
      const antBatch = /\/v1\/messages\/batches(?:\/([^/]+))?(?:\/(cancel|results))?$/.exec(
        pathOnly,
      );
      const m = orBatch ?? antBatch;
      if (m !== null && !model.includes('srvfail')) {
        const isAnthropic = antBatch !== null;
        const render = (b: StubBatch, withResults: boolean): unknown =>
          isAnthropic ? anthropicBatchObject(b) : openRouterBatchObject(b, withResults);
        const id = m[1];
        const action = m[2];
        if (req.method === 'POST' && id === undefined) {
          const doc = body as {
            endpoint?: string;
            model?: string;
            requests?: {
              custom_id: string;
              body?: Record<string, unknown>;
              params?: Record<string, unknown>;
            }[];
          };
          const items = (doc.requests ?? []).map((r) => ({
            custom_id: r.custom_id,
            body: r.body ?? r.params ?? {},
          }));
          const batchModel = doc.model ?? (items[0]?.body['model'] as string | undefined) ?? '';
          // `*batchreject*` → the upstream's own validation refuses the create.
          if (batchModel.includes('batchreject')) {
            return json(
              400,
              isAnthropic
                ? {
                    type: 'error',
                    error: { type: 'invalid_request_error', message: 'stub refused the batch' },
                  }
                : { error: { message: 'Batch API is text-only: stub refused', code: 400 } },
            );
          }
          batchSeq += 1;
          // The upstream id carries any behaviour marker in the batch-level model
          // name, so a test can drive the results route it cannot otherwise name.
          const marker = ['bigresults', 'midfail'].find((m) => batchModel.includes(m));
          const b: StubBatch = {
            id: `${isAnthropic ? 'msgbatch' : 'batch'}_${marker !== undefined ? `${marker}_` : ''}${String(batchSeq)}`,
            model: batchModel,
            endpoint: isAnthropic ? '/v1/messages' : (doc.endpoint ?? '/v1/chat/completions'),
            status: isAnthropic ? 'in_progress' : 'validating',
            created_at: Math.floor(Date.now() / 1000),
            requests: items,
            results: null,
            cancel_initiated: false,
          };
          batches.set(b.id, b);
          return json(isAnthropic ? 200 : 202, render(b, false));
        }
        if (req.method === 'GET' && id === undefined) {
          const data = [...batches.values()].reverse().map((b) => render(b, false));
          return json(
            200,
            isAnthropic
              ? {
                  data,
                  first_id: data.length > 0 ? (data[0] as { id: string }).id : null,
                  last_id: null,
                  has_more: false,
                }
              : { object: 'list', data, first_id: null, last_id: null, has_more: false },
          );
        }
        const b = id !== undefined ? batches.get(id) : undefined;
        if (b === undefined) {
          return json(
            404,
            isAnthropic
              ? { type: 'error', error: { type: 'not_found_error', message: 'nope' } }
              : { error: { message: 'batch not found', code: 404 } },
          );
        }
        if (action === 'cancel') {
          b.cancel_initiated = true;
          if (!['completed', 'failed', 'expired', 'cancelled'].includes(b.status))
            b.status = 'cancelling';
          return json(200, render(b, false));
        }
        if (action === 'results') {
          if (b.results === null)
            return json(404, {
              type: 'error',
              error: { type: 'not_found_error', message: 'not ended' },
            });
          res.writeHead(200, { 'content-type': 'application/x-jsonl' });
          const results = b.results;
          const render = (r: StubBatchResult): string =>
            `${JSON.stringify(
              r.response !== null
                ? {
                    custom_id: r.custom_id,
                    result: { type: 'succeeded', message: r.response.body },
                  }
                : {
                    custom_id: r.custom_id,
                    result: {
                      type: 'errored',
                      error: {
                        type: 'error',
                        error: { type: 'rate_limit_error', message: r.error?.message ?? '' },
                      },
                    },
                  },
            )}\n`;
          // `*bigresults*` → written DRAIN-AWARE, so `resultLinesSent` is a sound
          // observable of end-to-end backpressure; `*midfail*` → the socket is
          // severed after a few lines (a POST-commit upstream failure).
          const drainAware = b.id.includes('bigresults');
          const midFail = b.id.includes('midfail');
          if (!drainAware && !midFail) {
            for (const r of results) {
              res.write(render(r));
              resultLinesSent += 1;
            }
            return res.end();
          }
          const write = (payload: string): Promise<void> =>
            new Promise((resolve) => {
              if (res.destroyed || res.writableEnded) return resolve();
              if (res.write(payload)) return resolve();
              const done = (): void => {
                res.off('drain', done);
                res.off('close', done);
                res.off('error', done);
                resolve();
              };
              res.once('drain', done);
              res.once('close', done);
              res.once('error', done);
            });
          void (async () => {
            let i = 0;
            for (const r of results) {
              if (res.destroyed || res.writableEnded) return;
              if (midFail && i === 2) {
                res.socket?.destroy();
                return;
              }
              await write(render(r));
              resultLinesSent += 1;
              i += 1;
            }
            if (!res.writableEnded && !res.destroyed) res.end();
          })();
          return;
        }
        return json(200, render(b, true));
      }
      // `*srvfail*` → an HTTP 500 (a retryable upstream error → chain fallback).
      if (model.includes('srvfail')) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'stub failure' } }));
      }
      // `*badreq*` → an HTTP 400. fix-bad-request-dead-end: now fallback-ELIGIBLE — a
      // 400 in a router describes the model the router CHOSE, not a defect in the
      // caller's request. The body carries a `code` AND a prompt-echoing message, the
      // exact shape of the reported incident: the code is retained as a marker, the
      // message stays withheld, and the chain walks on.
      if (model.includes('badreq')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            error: {
              code: 'context_length_exceeded',
              message: 'invalid request: messages[3] said "my secret plan is to eat lunch"',
            },
          }),
        );
      }
      // fix-4xx-error-taxonomy. The 4xx statuses whose classification this change
      // corrects — each one a routing decision, not just a label.
      // `*nofunds*` → HTTP 402: an exhausted credit balance. Fallback-ELIGIBLE (a
      // different provider can serve the identical request) and breaker-tripping.
      if (model.includes('nofunds')) {
        res.writeHead(402, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({ error: { message: 'Insufficient credits. Add more to continue.' } }),
        );
      }
      // `*modblock*` → HTTP 403 carrying a moderation marker → `content_policy`.
      if (model.includes('modblock')) {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({ error: { type: 'content_filter', message: 'flagged by moderation' } }),
        );
      }
      // `*noperm*` → a marker-free HTTP 403 → `permission`. The COMMON shape, and
      // the one that used to trip the provider breaker as `auth`.
      if (model.includes('noperm')) {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'your key may not use this model' } }));
      }
      // `*legal*` → HTTP 451 → `policy_block`: the walk STOPS rather than routing
      // around a legally-mandated denial.
      if (model.includes('legal')) {
        res.writeHead(451, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'unavailable for legal reasons' } }));
      }
      // `*oversized*` → a 200 whose BODY exceeds the buffered transport ceiling
      // (DEFAULT_MAX_RESPONSE_BYTES, 10 MiB) → `oversized_response`
      // (fix-bad-request-dead-end). The drain cancels the reader past the cap, so the
      // walk must STOP: walking on would re-drain a second over-cap body on the next
      // member, which is the flood this kind exists to prevent.
      if (model.includes('oversized')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        // 11 MiB of filler — comfortably past the cap, streamed so the drain trips
        // mid-read exactly as it would against a real hostile endpoint.
        const chunk = 'x'.repeat(1024 * 1024);
        for (let i = 0; i < 11; i += 1) res.write(chunk);
        return res.end();
      }
      // `*teapot*` → an unnamed 4xx → `upstream_rejected`: fallback-eligible and
      // strictly breaker-neutral.
      if (model.includes('teapot')) {
        res.writeHead(418, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'no coffee here' } }));
      }
      // `*hang*` → headers then no body (tests the #14 cascade cheap-response deadline).
      if (model.includes('hang')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return; // never end — the caller's deadline aborts it
      }
      // `*slowhead*` → a PRE-HEADERS delay (fix-long-call-timeouts): trips the
      // effective first-byte bound unless the provider's override raised it.
      if (model.includes('slowhead')) {
        setTimeout(() => {
          if (res.socket?.destroyed) return; // the adapter already aborted
          if (path.endsWith('/chat/completions')) {
            return stream ? openaiStream(res, model) : void openaiJson(res, model);
          }
          res.writeHead(404);
          res.end();
        }, 1_000);
        return;
      }
      if (path.endsWith('/chat/completions')) {
        if (stream && model.includes('bigframes'))
          return openaiStreamBigFrames(res, model, () => bigFramesSent++);
        return stream ? openaiStream(res, model) : openaiJson(res, model);
      }
      if (path.endsWith('/v1/messages'))
        return stream ? anthropicStream(res, model) : anthropicJson(res, model);
      if (path.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
      }
      res.writeHead(404);
      res.end();
    })();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    batches,
    resultLinesSent: () => resultLinesSent,
    framesSent: () => bigFramesSent,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}
