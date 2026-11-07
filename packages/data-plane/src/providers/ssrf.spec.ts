import { SsrfError } from '@polyrouter/shared/server';
import { createGuardedHttpClient } from './http';
import { createOpenaiProviderAdapter } from './openai-adapter';

const GET = { method: 'GET', headers: {} };

describe('guarded HTTP client — SSRF at connect time', () => {
  it('refuses a host that resolves public at validation but private at connect (rebinding)', async () => {
    let call = 0;
    const resolve = (): Promise<string[]> => {
      call += 1;
      return Promise.resolve(call === 1 ? ['93.184.216.34'] : ['10.0.0.1']);
    };
    const client = createGuardedHttpClient({ mode: 'cloud', providerKind: 'api_key', resolve });
    await expect(client('https://rebind.example/v1/models', GET)).rejects.toBeInstanceOf(SsrfError);
    expect(call).toBeGreaterThanOrEqual(2); // validated, then re-checked at connect
  });

  it('refuses a literal private IP before any bytes are sent', async () => {
    const client = createGuardedHttpClient({ mode: 'cloud', providerKind: 'api_key' });
    await expect(client('http://10.0.0.1/v1/models', GET)).rejects.toBeInstanceOf(SsrfError);
  });

  it('refuses loopback for a non-local kind (no self-host exception)', async () => {
    const client = createGuardedHttpClient({ mode: 'cloud', providerKind: 'api_key' });
    await expect(client('http://127.0.0.1:9/v1/models', GET)).rejects.toBeInstanceOf(SsrfError);
  });

  it('refuses the metadata address', async () => {
    const client = createGuardedHttpClient({ mode: 'cloud', providerKind: 'api_key' });
    await expect(client('http://169.254.169.254/latest/meta-data', GET)).rejects.toBeInstanceOf(
      SsrfError,
    );
  });
});

describe('adapter model-listing URL override — SSRF at connect time (add-key-subscription-presets)', () => {
  it('an override that resolves to a blocked address fails typed and the credential never leaves the process', async () => {
    const connects: string[] = [];
    // The guarded client resolves through this seam; a private answer must stop the call
    // before any socket is opened (an open would need the dispatcher, never reached).
    const resolve = (host: string): Promise<string[]> => {
      connects.push(host);
      return Promise.resolve(['10.0.0.1']);
    };
    const guarded = createGuardedHttpClient({
      mode: 'cloud',
      providerKind: 'subscription',
      resolve,
    });
    const sent: string[] = [];
    const client: typeof guarded = (url, init) => {
      sent.push(url);
      return guarded(url, init);
    };
    const adapter = createOpenaiProviderAdapter(
      {
        protocol: 'openai_compatible',
        baseUrl: 'https://public.example/openai/v1',
        modelsUrl: 'https://internal-listing.example/v1/models',
        credential: 'sk-never-leaves',
        kind: 'subscription',
        mode: 'cloud',
      },
      { httpClient: client },
    );
    await expect(adapter.listModels()).rejects.toBeInstanceOf(SsrfError);
    const probe = await adapter.testConnection();
    expect(probe).toMatchObject({ ok: false, kind: 'unavailable' });
    expect(sent).toEqual([
      'https://internal-listing.example/v1/models',
      'https://internal-listing.example/v1/models',
    ]);
    // Only the override host was ever resolved, and it was refused: no byte was sent anywhere.
    expect(new Set(connects)).toEqual(new Set(['internal-listing.example']));
  });
});
