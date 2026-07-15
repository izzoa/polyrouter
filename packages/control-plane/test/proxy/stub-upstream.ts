// A local stub upstream speaking OpenAI + Anthropic wire (JSON + SSE), used by
// the proxy e2e. Behavior is switched by the (retargeted) model name so tests
// can drive error modes: `*miderror*` fails after a token, `*firsterror*` fails
// as the first event. Bound to 127.0.0.1 so a `local` provider passes the SSRF
// gate under MODE=selfhosted.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StubUpstream {
  readonly url: string;
  readonly requests: { path: string; auth: string | undefined; xApiKey: string | undefined }[];
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
  chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]);
  res.write('data: [DONE]\n\n');
  res.end();
}

export async function startStubUpstream(): Promise<StubUpstream> {
  const requests: StubUpstream['requests'] = [];
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
      if (path.endsWith('/chat/completions'))
        return stream ? openaiStream(res, model) : openaiJson(res, model);
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
