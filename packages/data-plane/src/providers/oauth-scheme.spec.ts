// add-subscription-oauth — the Anthropic authScheme switch: oauth_bearer sends
// Authorization: Bearer + the preset's anthropic-beta value and NO x-api-key;
// the default api_key scheme is byte-identical to the pre-existing headers.
import { createAnthropicProviderAdapter } from './anthropic-adapter';
import { createOpenaiProviderAdapter } from './openai-adapter';
import { recordingClient, jsonResponse } from './testkit.testkit';
import type { NormalizedRequest } from '../proxy/translate';

const BETA = 'oauth-2025-04-20';
const request: NormalizedRequest = {
  model: 'claude-sonnet-4-5',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  params: {},
};
const ANT_RESPONSE = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-5',
  content: [{ type: 'text', text: 'Hello!' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};
const base = {
  protocol: 'anthropic_compatible' as const,
  baseUrl: 'https://api.anthropic.com',
  credential: 'sk-ant-oat01-access',
  kind: 'subscription' as const,
  mode: 'selfhosted' as const,
  defaultMaxOutputTokens: 4096,
};

describe('Anthropic authScheme switch (add-subscription-oauth)', () => {
  it('oauth_bearer sends Bearer + anthropic-beta and NO x-api-key', async () => {
    const { client, calls } = recordingClient(() => jsonResponse(ANT_RESPONSE));
    const adapter = createAnthropicProviderAdapter(
      { ...base, authScheme: 'oauth_bearer', oauthBeta: BETA },
      { httpClient: client },
    );
    await adapter.chat(request);
    const h = calls[0]!.init.headers;
    expect(h['Authorization']).toBe('Bearer sk-ant-oat01-access');
    expect(h['anthropic-beta']).toBe(BETA);
    expect(h['anthropic-version']).toBe('2023-06-01');
    expect(h['x-api-key']).toBeUndefined();
  });

  it('the default api_key scheme is byte-identical to today (x-api-key, no Bearer)', async () => {
    const { client, calls } = recordingClient(() => jsonResponse(ANT_RESPONSE));
    const adapter = createAnthropicProviderAdapter(
      { ...base, credential: 'sk-ant-key', kind: 'api_key' },
      { httpClient: client },
    );
    await adapter.chat(request);
    const h = calls[0]!.init.headers;
    expect(h['x-api-key']).toBe('sk-ant-key');
    expect(h['anthropic-version']).toBe('2023-06-01');
    expect(h['Authorization']).toBeUndefined();
    expect(h['anthropic-beta']).toBeUndefined();
  });

  it('oauth_bearer without the preset beta value is a typed configuration error', () => {
    expect(() =>
      createAnthropicProviderAdapter({ ...base, authScheme: 'oauth_bearer' }, {}),
    ).toThrow('oauthBeta');
  });

  it('the OpenAI-compatible adapter is unchanged under either scheme (already Bearer)', async () => {
    const { client, calls } = recordingClient(() =>
      jsonResponse({
        id: 'c',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
      }),
    );
    const adapter = createOpenaiProviderAdapter(
      {
        protocol: 'openai_compatible',
        baseUrl: 'https://api.openai.example/v1',
        credential: 'sk-1',
        kind: 'subscription',
        mode: 'selfhosted',
        authScheme: 'oauth_bearer',
      },
      { httpClient: client },
    );
    await adapter.chat({ model: 'm', messages: request.messages, params: {} });
    expect(calls[0]!.init.headers['Authorization']).toBe('Bearer sk-1');
  });
});
