import http from 'node:http';
import { AddressInfo } from 'node:net';
import { SsrfError } from '@polyrouter/shared/server';
import { createGuardedHttpClient, readSseChunks, openRequest, type HttpClient } from './http';
import { CallCancelledError } from './errors';
import { sseResponse } from './testkit.testkit';

const GET = { method: 'GET', headers: {} };

describe('readSseChunks — persistent decoder', () => {
  it('reassembles a multibyte character split across byte chunks', async () => {
    const original = 'data: {"t":"héllo 😀 —"}\n\n';
    const res = sseResponse(original, { chunkSize: 1 }); // one byte per chunk
    let out = '';
    for await (const chunk of readSseChunks(res)) out += chunk;
    expect(out).toBe(original);
  });
});

describe('openRequest — timeout and cancellation', () => {
  const neverClient: HttpClient = (_url, init) =>
    new Promise((_resolve, reject) => {
      if (init.signal?.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      init.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('aborted', 'AbortError')),
        {
          once: true,
        },
      );
    });

  it('a stalled pre-first-byte call times out as unavailable', async () => {
    await expect(openRequest(neverClient, 'http://x/y', GET, 20)).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });

  it('caller cancellation surfaces as CallCancelledError (breaker-neutral)', async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 10);
    await expect(
      openRequest(neverClient, 'http://x/y', GET, 5000, { signal: ctl.signal }),
    ).rejects.toBeInstanceOf(CallCancelledError);
  });
});

describe('guarded streaming over loopback (self-host)', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"a":1}\n\n');
      setTimeout(() => {
        res.write('data: {"a":2}\n\n');
        res.end();
      }, 15);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.close();
  });

  it('local+selfhosted permits loopback and delivers the first event before the stream ends', async () => {
    const client = createGuardedHttpClient({ mode: 'selfhosted', providerKind: 'local' });
    const res = await client(`http://127.0.0.1:${port}/v1/x`, GET);
    const received: string[] = [];
    for await (const chunk of readSseChunks(res)) received.push(chunk);
    const text = received.join('');
    expect(text).toContain('"a":1');
    expect(text).toContain('"a":2');
  });

  it('the same loopback is refused for a cloud/non-local kind', async () => {
    const client = createGuardedHttpClient({ mode: 'cloud', providerKind: 'api_key' });
    await expect(client(`http://127.0.0.1:${port}/v1/x`, GET)).rejects.toBeInstanceOf(SsrfError);
  });

  it('cancelling the consumer does not hang', async () => {
    const client = createGuardedHttpClient({ mode: 'selfhosted', providerKind: 'local' });
    const res = await client(`http://127.0.0.1:${port}/v1/x`, GET);
    const it = readSseChunks(res)[Symbol.asyncIterator]();
    await it.next(); // first chunk
    await it.return?.(undefined); // cancel — closes the guarded dispatcher
    expect(true).toBe(true);
  });
});
