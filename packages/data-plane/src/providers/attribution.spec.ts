// add-openrouter-attribution — polyrouter identifies itself to OpenRouter via
// HTTP-Referer + X-OpenRouter-Title on requests to openrouter.ai-host providers.
// The identity is disclosed ONLY to OpenRouter; auth is never affected.
import { createOpenaiProviderAdapter } from './openai-adapter';
import { openRouterAttributionHeaders } from './http-adapter';
import { recordingClient, jsonResponse, sseResponse, oaiSse } from './testkit.testkit';
import type { NormalizedRequest } from '../proxy/translate';

const REFERER = 'https://polyrouter.app';
const TITLE = 'polyrouter';

const request: NormalizedRequest = {
  model: 'openai/gpt-5.2',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  params: {},
};
const OAI_RESPONSE = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};
const configFor = (baseUrl: string) => ({
  protocol: 'openai_compatible' as const,
  baseUrl,
  credential: 'sk-secret-123',
  kind: 'api_key' as const,
  mode: 'cloud' as const,
});

describe('openRouterAttributionHeaders — host gate', () => {
  const A = { 'HTTP-Referer': REFERER, 'X-OpenRouter-Title': TITLE };

  it('matches openrouter.ai, its uppercase, an explicit port, and a trailing FQDN dot', () => {
    expect(openRouterAttributionHeaders('https://openrouter.ai/api/v1')).toEqual(A);
    expect(openRouterAttributionHeaders('https://OpenRouter.AI/api/v1')).toEqual(A);
    expect(openRouterAttributionHeaders('https://openrouter.ai:443/api/v1')).toEqual(A);
    expect(openRouterAttributionHeaders('https://openrouter.ai./api/v1')).toEqual(A); // trailing dot
  });

  it('does NOT match a subdomain, a spoofed suffix, or another provider', () => {
    expect(openRouterAttributionHeaders('https://x.openrouter.ai/v1')).toEqual({});
    expect(openRouterAttributionHeaders('https://sub.openrouter.ai.evil.com/v1')).toEqual({});
    expect(openRouterAttributionHeaders('https://api.openai.com/v1')).toEqual({});
    expect(openRouterAttributionHeaders('https://api.anthropic.com')).toEqual({});
  });

  it('returns {} (no throw) for an unparseable base_url', () => {
    expect(openRouterAttributionHeaders('not a url')).toEqual({});
    expect(openRouterAttributionHeaders('')).toEqual({});
  });

  it('sends the canonical X-OpenRouter-Title, never the legacy X-Title', () => {
    const h = openRouterAttributionHeaders('https://openrouter.ai/api/v1');
    expect(h['X-OpenRouter-Title']).toBe(TITLE);
    expect(h['X-Title']).toBeUndefined();
  });
});

describe('adapter attribution — requests to OpenRouter carry it; others do not', () => {
  it('chat to an openrouter.ai host carries attribution alongside the bearer', async () => {
    const { client, calls } = recordingClient(() => jsonResponse(OAI_RESPONSE));
    const adapter = createOpenaiProviderAdapter(configFor('https://openrouter.ai/api/v1'), {
      httpClient: client,
    });
    await adapter.chat(request);
    const h = calls[0]!.init.headers;
    expect(h['HTTP-Referer']).toBe(REFERER);
    expect(h['X-OpenRouter-Title']).toBe(TITLE);
    expect(h['Authorization']).toBe('Bearer sk-secret-123'); // auth untouched
  });

  it('a streaming request to openrouter.ai also carries attribution', async () => {
    const chunks = [
      { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ];
    const { client, calls } = recordingClient(() => sseResponse(oaiSse(chunks)));
    const adapter = createOpenaiProviderAdapter(configFor('https://openrouter.ai/api/v1'), {
      httpClient: client,
    });
    for await (const _ev of adapter.chatStream(request)) {
      /* drain */
    }
    const h = calls[0]!.init.headers;
    expect(h['HTTP-Referer']).toBe(REFERER);
    expect(h['Accept']).toBe('text/event-stream');
  });

  it('a non-OpenRouter host carries neither attribution header', async () => {
    const { client, calls } = recordingClient(() => jsonResponse(OAI_RESPONSE));
    const adapter = createOpenaiProviderAdapter(configFor('https://api.openai.example/v1'), {
      httpClient: client,
    });
    await adapter.chat(request);
    const h = calls[0]!.init.headers;
    expect(h['HTTP-Referer']).toBeUndefined();
    expect(h['X-OpenRouter-Title']).toBeUndefined();
    expect(h['Authorization']).toBe('Bearer sk-secret-123');
  });
});
