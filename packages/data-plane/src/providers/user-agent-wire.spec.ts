// add-honest-user-agent task 2.4 — the REAL guarded transport on a loopback server:
// the backstop fills a missing User-Agent and never replaces a present one, and an
// adapter over it sends exactly one raw `user-agent`, never the library default.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { POLYROUTER_USER_AGENT } from '@polyrouter/shared/server';
import { createGuardedHttpClient } from './http';
import { createOpenaiProviderAdapter } from './openai-adapter';
import type { NormalizedRequest } from '../proxy/translate';

const request: NormalizedRequest = {
  model: 'm',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  params: {},
};

describe('guarded client — User-Agent backstop (outbound-user-agent)', () => {
  let server: http.Server;
  let port: number;
  /** The RAW header list of each request, in arrival order. */
  let raws: string[][] = [];

  /** Every User-Agent value in a raw header list. */
  const uas = (raw: string[]): string[] => {
    const out: string[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      if (raw[i]?.toLowerCase() === 'user-agent') out.push(raw[i + 1] ?? '');
    }
    return out;
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      raws.push([...req.rawHeaders]);
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        if (req.url?.endsWith('/models')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [{ id: 'm' }] }));
        } else if (body.includes('"stream":true')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const chunk = (d: unknown): string => `data: ${JSON.stringify(d)}\n\n`;
          res.end(
            chunk({
              id: 's',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }],
            }) +
              chunk({
                id: 's',
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              }) +
              'data: [DONE]\n\n',
          );
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'c',
              object: 'chat.completion',
              choices: [
                { index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' },
              ],
            }),
          );
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  beforeEach(() => {
    raws = [];
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const url = (p: string): string => `http://127.0.0.1:${String(port)}${p}`;
  const client = (): ReturnType<typeof createGuardedHttpClient> =>
    createGuardedHttpClient({ mode: 'selfhosted', providerKind: 'local' });

  it('a request sent with no User-Agent arrives with polyrouter/<version>', async () => {
    const res = await client()(url('/x'), { method: 'GET', headers: {} });
    await res.text();
    expect(uas(raws[0]!)).toEqual([POLYROUTER_USER_AGENT]);
  });

  it('a request sent with User-Agent: identity/1.0 arrives unchanged (the builder stays authoritative)', async () => {
    for (const key of ['User-Agent', 'user-agent']) {
      raws = [];
      const res = await client()(url('/x'), { method: 'GET', headers: { [key]: 'identity/1.0' } });
      await res.text();
      expect(uas(raws[0]!)).toEqual(['identity/1.0']);
    }
  });

  it.each([
    ['without extraHeaders', undefined, POLYROUTER_USER_AGENT],
    ['with an extraHeaders User-Agent', { 'USER-AGENT': 'identity/1.0' }, 'identity/1.0'],
  ])(
    'an OpenAI-compatible adapter over the real client, %s, sends one raw user-agent',
    async (_label, extraHeaders, expected) => {
      const adapter = createOpenaiProviderAdapter({
        protocol: 'openai_compatible',
        baseUrl: url('/v1'),
        credential: 'sk-secret',
        kind: 'local',
        mode: 'selfhosted',
        ...(extraHeaders !== undefined ? { extraHeaders } : {}),
      });
      await adapter.chat(request);
      for await (const ev of adapter.chatStream(request)) void ev;
      await adapter.listModels();
      expect(raws).toHaveLength(3);
      for (const raw of raws) {
        expect(uas(raw)).toEqual([expected]);
        expect(uas(raw)[0]).not.toMatch(/undici|node/i);
      }
    },
  );
});
