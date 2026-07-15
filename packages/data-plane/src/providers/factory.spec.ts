import { SsrfError } from '@polyrouter/shared/server';
import { createProviderAdapter } from './factory';
import type { NormalizedRequest } from '../proxy/translate';

const base = {
  baseUrl: 'https://api.example/v1',
  credential: 'k',
  kind: 'api_key' as const,
  mode: 'cloud' as const,
};

const request: NormalizedRequest = {
  model: 'm',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  params: {},
};

describe('provider adapter factory', () => {
  it('selects the adapter by protocol', () => {
    expect(createProviderAdapter({ ...base, protocol: 'openai_compatible' }).protocol).toBe(
      'openai_compatible',
    );
    expect(createProviderAdapter({ ...base, protocol: 'anthropic_compatible' }).protocol).toBe(
      'anthropic_compatible',
    );
  });

  it('rejects a local provider under MODE=cloud', () => {
    expect(() =>
      createProviderAdapter({
        ...base,
        protocol: 'openai_compatible',
        kind: 'local',
        mode: 'cloud',
      }),
    ).toThrow(/selfhosted/i);
  });

  it('defaults to the guarded HTTP client (a private base_url is refused)', async () => {
    const adapter = createProviderAdapter({
      ...base,
      protocol: 'openai_compatible',
      baseUrl: 'http://10.0.0.1/v1',
    });
    await expect(adapter.chat(request)).rejects.toBeInstanceOf(SsrfError);
  });
});
