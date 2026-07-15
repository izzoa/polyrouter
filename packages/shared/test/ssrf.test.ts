import { createServer, type Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertUrlSafe,
  classifyIp,
  guardedFetch,
  isBlockedIp,
  SsrfError,
  type UrlGuardOptions,
} from '../src/server';

const CLOUD: UrlGuardOptions = { context: { mode: 'cloud' } };
const LOCAL: UrlGuardOptions = { context: { mode: 'selfhosted', providerKind: 'local' } };

async function expectSsrf(p: Promise<unknown>, code?: string): Promise<void> {
  await expect(p).rejects.toBeInstanceOf(SsrfError);
  if (code) await expect(p).rejects.toMatchObject({ code });
}

describe('isBlockedIp (ssrf-url-guard)', () => {
  it('blocks dangerous v4/v6/mapped/NAT64 addresses', () => {
    for (const ip of [
      '169.254.169.254',
      '127.0.0.1',
      '0.0.0.0',
      '10.0.0.1',
      '172.16.5.4',
      '192.168.1.1',
      '100.64.0.1',
      '192.88.99.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:169.254.169.254',
      '::ffff:127.0.0.1',
      '64:ff9b::7f00:1',
      '2002::1',
      '100::1',
    ]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });

  it('allows routable public addresses', () => {
    expect(isBlockedIp('93.184.216.34')).toBe(false);
    expect(isBlockedIp('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
  });

  it('narrows the loopback exception to loopback only', () => {
    expect(classifyIp('127.0.0.1', { allowLoopback: true })).toBe('ok');
    expect(classifyIp('::1', { allowLoopback: true })).toBe('ok');
    expect(classifyIp('169.254.169.254', { allowLoopback: true })).toBe('hard');
    expect(classifyIp('10.0.0.1', { allowLoopback: true })).toBe('soft');
  });

  it('honors extraBlockedCidrs and rejects non-IPs', () => {
    expect(isBlockedIp('203.0.113.9')).toBe(true); // TEST-NET-3 already hard
    expect(isBlockedIp('8.8.8.8', { extraBlockedCidrs: ['8.8.8.0/24'] })).toBe(true);
    expect(classifyIp('not-an-ip')).toBe('hard');
  });
});

describe('assertUrlSafe (ssrf-url-guard)', () => {
  it('rejects SSRF targets and encodings', async () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data',
      'http://localhost',
      'http://10.0.0.1',
      'https://[::1]',
      'https://[fd00::1]',
      'http://2130706433', // decimal 127.0.0.1
      'http://0177.0.0.1', // octal
      'http://0x7f.0.0.1', // hex
      'http://public@169.254.169.254', // userinfo trick
      'http://127.0.0.1.', // trailing dot resolves nowhere public
    ]) {
      await expectSsrf(assertUrlSafe(url, CLOUD));
    }
  });

  it('rejects non-http(s) schemes and zone ids', async () => {
    await expectSsrf(assertUrlSafe('file:///etc/passwd', CLOUD), 'bad_protocol');
    await expectSsrf(assertUrlSafe('gopher://evil', CLOUD), 'bad_protocol');
    // a zone id makes the URL unparseable — rejected either way (SsrfError)
    await expectSsrf(assertUrlSafe('https://[fe80::1%25eth0]', CLOUD));
  });

  it('requires https for remote; permits http only for loopback/allowlisted', async () => {
    await expectSsrf(assertUrlSafe('http://example.com', CLOUD), 'not_https');
    await expect(assertUrlSafe('https://example.com', CLOUD)).resolves.toBeInstanceOf(URL);
    await expectSsrf(assertUrlSafe('http://127.0.0.1:11434', CLOUD)); // cloud → blocked
    await expect(assertUrlSafe('http://127.0.0.1:11434', LOCAL)).resolves.toBeInstanceOf(URL);
  });

  it('rejects if ANY resolved record is blocked (mixed public/private)', async () => {
    const resolve = (): Promise<string[]> => Promise.resolve(['93.184.216.34', '10.0.0.5']);
    await expectSsrf(assertUrlSafe('https://mixed.example', { ...CLOUD, resolve }), 'blocked_ip');
  });

  it('address- and port-bounds the allowlist and rejects HARD-overlapping entries', async () => {
    const opts: UrlGuardOptions = {
      context: { mode: 'cloud' },
      allowedEndpoints: [{ host: 'ollama.lan', cidr: '10.1.0.0/16', port: 11434 }],
      resolve: () => Promise.resolve(['10.1.2.3']),
    };
    await expect(assertUrlSafe('http://ollama.lan:11434', opts)).resolves.toBeInstanceOf(URL);
    // wrong port
    await expectSsrf(assertUrlSafe('http://ollama.lan:9999', opts), 'blocked_ip');
    // resolves outside the CIDR
    await expectSsrf(
      assertUrlSafe('http://ollama.lan:11434', {
        ...opts,
        resolve: () => Promise.resolve(['192.168.0.1']),
      }),
      'blocked_ip',
    );
    // an allowlist entry overlapping loopback is rejected at construction
    await expect(
      assertUrlSafe('http://x', {
        context: { mode: 'cloud' },
        allowedEndpoints: [{ host: 'x', cidr: '127.0.0.0/8' }],
      }),
    ).rejects.toThrow(/overlaps a hard-blocked range/);
  });
});

describe('guardedFetch (ssrf-url-guard)', () => {
  const servers: Server[] = [];
  afterAll(() => {
    for (const s of servers) s.close();
  });

  interface TestServer {
    port: number;
    accepted: () => number;
    authSeen: () => string | null;
  }

  function startServer(
    handler: (path: string, port: number) => { status: number; location?: string },
  ): Promise<TestServer> {
    return new Promise((resolve) => {
      let accepted = 0;
      let authSeen: string | null = null;
      const server = createServer((req, res) => {
        accepted += 1;
        if (req.headers.authorization) authSeen = req.headers.authorization;
        const addr = server.address();
        const port = addr && typeof addr !== 'string' ? addr.port : 0;
        const { status, location } = handler(req.url ?? '/', port);
        if (location) res.setHeader('location', location);
        res.statusCode = status;
        res.end('ok');
      });
      servers.push(server);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr !== 'string') {
          resolve({ port: addr.port, accepted: () => accepted, authSeen: () => authSeen });
        }
      });
    });
  }

  it('rejects a rebinding host BEFORE connecting — the private listener accepts nothing', async () => {
    const srv = await startServer(() => ({ status: 200 }));
    // name-time public (call 1), connect-time loopback (call 2) — rebinding.
    let calls = 0;
    const resolve = (): Promise<string[]> => {
      calls += 1;
      return Promise.resolve(calls === 1 ? ['93.184.216.34'] : ['127.0.0.1']);
    };
    await expectSsrf(
      guardedFetch(
        `https://rebind.example:${String(srv.port)}`,
        {},
        { context: { mode: 'cloud' }, resolve },
      ),
      'blocked_ip',
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(srv.accepted()).toBe(0); // never even connected
  });

  it('follows a same-origin redirect and returns the final response', async () => {
    const srv = await startServer((path) =>
      path === '/redir' ? { status: 302, location: '/final' } : { status: 200 },
    );
    // loopback-allowed context so the local server is reachable.
    const res = await guardedFetch(`http://127.0.0.1:${String(srv.port)}/redir`, {}, LOCAL);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('rejects a cross-origin redirect without forwarding the Authorization header', async () => {
    const other = await startServer(() => ({ status: 200 }));
    const srv = await startServer((path, _port) =>
      path === '/redir'
        ? { status: 302, location: `http://127.0.0.1:${String(other.port)}/steal` }
        : { status: 200 },
    );
    await expectSsrf(
      guardedFetch(
        `http://127.0.0.1:${String(srv.port)}/redir`,
        { headers: { authorization: 'Bearer poly_secret' } },
        LOCAL,
      ),
      'cross_origin_redirect',
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(other.authSeen()).toBeNull(); // the secret never reached the other origin
  });

  it('returns a normal response for a public-context loopback fetch', async () => {
    const srv = await startServer(() => ({ status: 200 }));
    const res = await guardedFetch(`http://127.0.0.1:${String(srv.port)}/`, {}, LOCAL);
    expect(res.status).toBe(200);
  });
});
