// add-batch-inference task 2.7: the guarded transport accepts a STREAMED request
// body under the same SSRF/redirect/timeout rules as a string body.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SsrfError } from '@polyrouter/shared/server';
import { createGuardedHttpClient } from './http';

describe('guarded client — streamed request body', () => {
  let server: http.Server;
  let port: number;
  let received: Buffer[] = [];
  let firstChunkSeen: () => void = () => undefined;
  const firstChunk = (): Promise<void> =>
    new Promise((resolve) => {
      firstChunkSeen = resolve;
    });

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      received = [];
      req.on('data', (c: Buffer) => {
        if (received.length === 0) firstChunkSeen();
        received.push(c);
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ bytes: Buffer.concat(received).length }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('streams the body as the socket drains it — the second chunk is produced only after the server saw the first', async () => {
    const seen = firstChunk();
    let pulls = 0;
    const chunkA = new Uint8Array(64 * 1024).fill(0x61);
    const chunkB = new Uint8Array(64 * 1024).fill(0x62);
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(chunkA);
          return;
        }
        // A client that buffered the whole body before sending would deadlock
        // here: chunk B exists only once chunk A has reached the server.
        await seen;
        controller.enqueue(chunkB);
        controller.close();
      },
    });
    const client = createGuardedHttpClient({ mode: 'selfhosted', providerKind: 'local' });
    const res = await client(`http://127.0.0.1:${String(port)}/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bytes: 128 * 1024 });
    expect(pulls).toBe(2);
  });

  it('still refuses a private address before consuming the stream', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const client = createGuardedHttpClient({ mode: 'cloud', providerKind: 'api_key' });
    await expect(
      client('http://10.0.0.1/upload', { method: 'POST', headers: {}, body }),
    ).rejects.toBeInstanceOf(SsrfError);
    // The name-time gate ran before fetch touched the body: the stream was never
    // locked, and its bytes are still there to read.
    expect(body.locked).toBe(false);
    const { value } = await body.getReader().read();
    expect(Array.from(value ?? [])).toEqual([1, 2, 3]);
  });
});
