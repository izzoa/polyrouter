import { createOpenaiProviderAdapter } from './openai-adapter';
import type { NormalizedRequest } from '../proxy/translate';
import {
  recordingClient,
  jsonResponse,
  errorResponse,
  sseResponse,
  oaiSse,
} from './testkit.testkit';

const config = {
  protocol: 'openai_compatible' as const,
  baseUrl: 'https://api.openai.example/v1',
  credential: 'sk-secret-123',
  kind: 'api_key' as const,
  mode: 'cloud' as const,
};

const request: NormalizedRequest = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  params: {},
};

const OAI_RESPONSE = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1700000000,
  model: 'gpt-4o',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

describe('OpenAI provider adapter', () => {
  it('POSTs JSON to /chat/completions with bearer auth and returns the IR', async () => {
    const { client, calls } = recordingClient(() => jsonResponse(OAI_RESPONSE));
    const adapter = createOpenaiProviderAdapter(config, { httpClient: client });
    const res = await adapter.chat(request);

    expect(res.content).toEqual([{ type: 'text', text: 'Hello!' }]);
    expect(res.stopReason).toBe('stop');
    const call = calls[0]!;
    expect(call.url).toBe('https://api.openai.example/v1/chat/completions');
    expect(call.init.method).toBe('POST');
    expect(call.init.headers['Authorization']).toBe('Bearer sk-secret-123');
    expect(call.init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(call.init.body!) as { model: string; stream: boolean };
    expect(body.model).toBe('gpt-4o');
    expect(body.stream).toBe(false);
  });

  it('lists models from /models', async () => {
    const { client, calls } = recordingClient(() =>
      jsonResponse({ object: 'list', data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }),
    );
    const adapter = createOpenaiProviderAdapter(config, { httpClient: client });
    const models = await adapter.listModels();
    expect(models.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(calls[0]!.url).toBe('https://api.openai.example/v1/models');
  });

  it('streams events (Accept: text/event-stream) whose text concatenates', async () => {
    const chunks = [
      {
        id: 's',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      },
      {
        id: 's',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }],
      },
      {
        id: 's',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }],
      },
      {
        id: 's',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ];
    const { client, calls } = recordingClient(() => sseResponse(oaiSse(chunks)));
    const adapter = createOpenaiProviderAdapter(config, { httpClient: client });
    let text = '';
    for await (const ev of adapter.chatStream(request)) {
      if (ev.type === 'text_delta') text += ev.text;
    }
    expect(text).toBe('Hello');
    expect(calls[0]!.init.headers['Accept']).toBe('text/event-stream');
  });

  it('maps a 401 to a typed auth error', async () => {
    const { client } = recordingClient(() => errorResponse(401, 'Unauthorized'));
    const adapter = createOpenaiProviderAdapter(config, { httpClient: client });
    await expect(adapter.chat(request)).rejects.toMatchObject({ kind: 'auth' });
    expect((await adapter.testConnection()).ok).toBe(false);
  });
});
