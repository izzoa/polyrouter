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
  /** SSE frames fully handed to the socket by the `bigframes` model. The writer
   * is drain-aware (awaits `res.write() === false` → `'drain'`), so this counter
   * is a sound observable of end-to-end backpressure: it stalls when the proxy
   * stops pulling because ITS client stopped reading. */
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
  res.end(
    JSON.stringify({
      id: 'chatcmpl-stub',
      object: 'chat.completion',
      created: 1,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
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
  chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]);
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

export async function startStubUpstream(): Promise<StubUpstream> {
  const requests: StubUpstream['requests'] = [];
  let bigFramesSent = 0;
  // Track live sockets so close() can sever deliberately-open connections
  // (`neverend`, paused `bigframes` readers) instead of hanging on them.
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = req.url ?? '';
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as { model?: string; stream?: boolean }) : {};
      const model = body.model ?? '';
      const stream = body.stream === true;
      requests.push({
        path,
        auth: req.headers.authorization,
        xApiKey:
          typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined,
        closed: new Promise<void>((resolve) => res.once('close', resolve)),
      });
      // `*srvfail*` → an HTTP 500 (a retryable upstream error → chain fallback).
      if (model.includes('srvfail')) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'stub failure' } }));
      }
      // `*hang*` → headers then no body (tests the #14 cascade cheap-response deadline).
      if (model.includes('hang')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return; // never end — the caller's deadline aborts it
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
    framesSent: () => bigFramesSent,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}
