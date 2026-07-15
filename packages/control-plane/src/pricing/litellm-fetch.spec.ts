import { SsrfError } from '@polyrouter/shared/server';
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
