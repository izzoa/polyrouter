import { SsrfError } from '@polyrouter/shared/server';
import { createGuardedHttpClient } from './http';

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
