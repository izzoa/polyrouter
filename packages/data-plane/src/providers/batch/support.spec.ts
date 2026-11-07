// allow-preset-client-identity review fix: the batch call path must never send a
// protocol header twice when an identity declaration spells it in another letter case.
import type { HttpInit } from '../http';
import { jsonResponse, recordingClient } from '../testkit.testkit';
import { batchCall } from './support';
import type { BatchTransport } from './transport';

function transport(
  headers: Record<string, string>,
  respond: (url: string, init: HttpInit) => ReturnType<typeof jsonResponse>,
) {
  const { client, calls } = recordingClient(respond);
  const t = {
    baseUrl: 'https://upstream.example/v1',
    httpClient: client,
    headers: () => headers,
    credential: 'sk-SECRET',
    firstByteTimeoutMs: 1000,
    idleTimeoutMs: 1000,
    maxResponseBytes: 1 << 20,
  } as unknown as BatchTransport;
  return { t, calls };
}

describe('batchCall header layering', () => {
  it('sends exactly one Idempotency-Key (the polyrouter value) when the transport carries a case-variant', async () => {
    const { t, calls } = transport(
      { Authorization: 'Bearer x', 'idempotency-key': 'identity-value', 'X-Keep': 'yes' },
      () => jsonResponse({}),
    );
    const { dispose } = await batchCall(
      t,
      'https://upstream.example/v1/batches',
      { method: 'POST', body: '{}', idempotencyKey: 'job-1', notFoundIsBatch: false },
      undefined,
    );
    dispose();
    const keys = Object.entries(calls[0]!.init.headers).filter(
      ([k]) => k.toLowerCase() === 'idempotency-key',
    );
    expect(keys).toEqual([['Idempotency-Key', 'job-1']]);
    expect(calls[0]!.init.headers['X-Keep']).toBe('yes');
    expect(calls[0]!.init.headers['Authorization']).toBe('Bearer x');
  });

  it('lets a Content-Type override replace the transport JSON type in any letter case', async () => {
    const { t, calls } = transport({ 'content-type': 'application/json' }, () => jsonResponse({}));
    const { dispose } = await batchCall(
      t,
      'https://upstream.example/v1/files',
      {
        method: 'POST',
        body: '{}',
        contentType: 'multipart/form-data; boundary=b',
        notFoundIsBatch: false,
      },
      undefined,
    );
    dispose();
    const cts = Object.entries(calls[0]!.init.headers).filter(
      ([k]) => k.toLowerCase() === 'content-type',
    );
    expect(cts).toEqual([['Content-Type', 'multipart/form-data; boundary=b']]);
  });
});
