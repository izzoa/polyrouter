import { POLYROUTER_USER_AGENT, SsrfError } from '@polyrouter/shared/server';

const fetchMock = jest.fn();
jest.mock('undici', () => ({
  ...jest.requireActual<Record<string, unknown>>('undici'),
  fetch: (...args: unknown[]): unknown => fetchMock(...args),
}));

import { fetchLiteLlmCatalog, readCapped } from './litellm-fetch';

const opts = { mode: 'cloud' as const, timeoutMs: 5000, maxBytes: 1_000_000 };

describe('fetchLiteLlmCatalog — SSRF guard (no loopback exception)', () => {
  it('refuses a host that resolves to a metadata/private IP', async () => {
    await expect(
      fetchLiteLlmCatalog('https://pricing.example/litellm.json', {
        ...opts,
        resolve: () => Promise.resolve(['169.254.169.254']),
      }),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it('refuses a literal private IP and loopback (no self-host exception here)', async () => {
    await expect(fetchLiteLlmCatalog('http://10.0.0.1/x', opts)).rejects.toBeInstanceOf(SsrfError);
    await expect(fetchLiteLlmCatalog('http://127.0.0.1:9/x', opts)).rejects.toBeInstanceOf(
      SsrfError,
    );
  });
});

describe('fetchLiteLlmCatalog — outbound User-Agent (add-honest-user-agent)', () => {
  const publicResolve = (): Promise<string[]> => Promise.resolve(['93.184.216.34']);

  beforeEach(() => fetchMock.mockReset());

  it('sends exactly one polyrouter/<version> User-Agent and keeps redirect: manual', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    await expect(
      fetchLiteLlmCatalog('https://pricing.example/litellm.json', {
        ...opts,
        resolve: publicResolve,
      }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as {
      headers: Record<string, string>;
      redirect: string;
    };
    expect(init.redirect).toBe('manual');
    const uas = Object.keys(init.headers).filter((k) => k.toLowerCase() === 'user-agent');
    expect(uas).toEqual(['User-Agent']);
    expect(init.headers['User-Agent']).toBe(POLYROUTER_USER_AGENT);
    expect(init.headers['User-Agent']).toMatch(/^polyrouter\/\d+\.\d+\.\d+/);
  });

  it('still rejects a 302 with no second fetch', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/x' } }),
    );
    await expect(
      fetchLiteLlmCatalog('https://pricing.example/litellm.json', {
        ...opts,
        resolve: publicResolve,
      }),
    ).rejects.toThrow(/unexpected status 302/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('readCapped — streaming size cap', () => {
  const stream = (chunks: Uint8Array[]): ReadableStream<Uint8Array> => {
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (i < chunks.length) c.enqueue(chunks[i++]!);
        else c.close();
      },
    });
  };

  it('returns the text when under the cap', async () => {
    const bytes = new TextEncoder().encode('{"ok":true}');
    expect(await readCapped(stream([bytes]), 1000)).toBe('{"ok":true}');
  });

  it('aborts once the body exceeds the cap', async () => {
    const big = new Uint8Array(600);
    await expect(readCapped(stream([big, big]), 1000)).rejects.toThrow(/max size/i);
  });
});
