import { createOpenaiProviderAdapter } from './openai-adapter';
import { createAnthropicProviderAdapter } from './anthropic-adapter';
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
    const body = JSON.parse(call.init.body as string) as { model: string; stream: boolean };
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

describe('OpenAI provider adapter — max-tokens spelling (add-max-tokens-spelling)', () => {
  const capped: NormalizedRequest = {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    params: { maxOutputTokens: 100 },
  };
  const stopChunk = {
    id: 's',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'gpt-4o',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  };

  it('chat: the max_tokens quirk emits max_tokens, not max_completion_tokens', async () => {
    const { client, calls } = recordingClient(() => jsonResponse(OAI_RESPONSE));
    const adapter = createOpenaiProviderAdapter(
      { ...config, quirks: { maxTokensSpelling: 'max_tokens' } },
      { httpClient: client },
    );
    await adapter.chat(capped);
    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body.max_tokens).toBe(100);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it('chat: the default (no quirk) emits max_completion_tokens', async () => {
    const { client, calls } = recordingClient(() => jsonResponse(OAI_RESPONSE));
    const adapter = createOpenaiProviderAdapter(config, { httpClient: client });
    await adapter.chat(capped);
    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body.max_completion_tokens).toBe(100);
    expect(body.max_tokens).toBeUndefined();
  });

  it('chatStream: the max_tokens quirk emits max_tokens on the streamed request body', async () => {
    const { client, calls } = recordingClient(() => sseResponse(oaiSse([stopChunk])));
    const adapter = createOpenaiProviderAdapter(
      { ...config, quirks: { maxTokensSpelling: 'max_tokens' } },
      { httpClient: client },
    );
    for await (const ev of adapter.chatStream(capped)) void ev; // drain
    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body.max_tokens).toBe(100);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.stream).toBe(true);
  });
});

describe('adapter config — absolute model-listing URL (add-key-subscription-presets)', () => {
  const OVERRIDE = 'https://opencode.ai/inference/go/v1/models';
  const overridden = {
    ...config,
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    modelsUrl: OVERRIDE,
  };

  it('listModels and testConnection request the override with the normal Bearer header; chat keeps base_url', async () => {
    const { client, calls } = recordingClient((url) =>
      url.endsWith('/chat/completions')
        ? jsonResponse(OAI_RESPONSE)
        : jsonResponse({ object: 'list', data: [{ id: 'm1' }, { id: 'm2' }] }),
    );
    const adapter = createOpenaiProviderAdapter(overridden, { httpClient: client });
    const models = await adapter.listModels();
    expect(models.map((m) => m.id)).toEqual(['m1', 'm2']);
    const probe = await adapter.testConnection();
    expect(probe).toEqual({ ok: true, models: 2 });
    await adapter.chat(request);

    expect(calls.map((c) => c.url)).toEqual([
      OVERRIDE,
      OVERRIDE,
      'https://opencode.ai/inference/go/openai/v1/chat/completions',
    ]);
    for (const call of calls) {
      expect(call.init.headers['Authorization']).toBe('Bearer sk-secret-123');
    }
    expect(calls[0]!.init.method).toBe('GET');
  });

  it('without an override the URLs are unchanged', async () => {
    const { client, calls } = recordingClient((url) =>
      url.endsWith('/chat/completions')
        ? jsonResponse(OAI_RESPONSE)
        : jsonResponse({ object: 'list', data: [{ id: 'm1' }] }),
    );
    const adapter = createOpenaiProviderAdapter(config, { httpClient: client });
    await adapter.listModels();
    await adapter.testConnection();
    await adapter.chat(request);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.openai.example/v1/models',
      'https://api.openai.example/v1/models',
      'https://api.openai.example/v1/chat/completions',
    ]);
  });

  it('pagination still follows the cursor against the override', async () => {
    const anthropicOverride = 'https://models.example/listing/v1/models';
    const { client, calls } = recordingClient((url) =>
      url.includes('after_id=')
        ? jsonResponse({ data: [{ id: 'b', display_name: 'B' }], has_more: false })
        : jsonResponse({ data: [{ id: 'a', display_name: 'A' }], has_more: true, last_id: 'a' }),
    );
    const adapter = createAnthropicProviderAdapter(
      {
        protocol: 'anthropic_compatible',
        baseUrl: 'https://api.anthropic.example',
        credential: 'sk-ant-secret',
        kind: 'api_key',
        mode: 'cloud',
        modelsUrl: anthropicOverride,
      },
      { httpClient: client },
    );
    const models = await adapter.listModels();
    expect(models.map((m) => m.id)).toEqual(['a', 'b']);
    expect(calls.map((c) => c.url)).toEqual([anthropicOverride, `${anthropicOverride}?after_id=a`]);
  });
});

// classify-plan-quota-errors task 3.3: the dialect is threaded into the three non-2xx sites
// (buffered chat, stream open, listing) and nowhere else.
describe('adapter config — plan-error dialect (classify-plan-quota-errors)', () => {
  const zaiConfig = { ...config, errorDialect: 'zai' as const };
  const RESET = '2026-11-06T18:00:00+08:00';
  const ZAI_1308 = JSON.stringify({
    error: {
      code: '1308',
      message: `Usage limit reached for 5 hours. Your limit will reset at ${RESET}`,
    },
  });
  const ZAI_1309 = JSON.stringify({
    error: { code: '1309', message: 'Your GLM Coding Plan package has expired.' },
  });
  const refuse = (text: string, headers: Record<string, string> = {}) =>
    recordingClient(() => errorResponse(429, text, headers));

  const drain = async (adapter: ReturnType<typeof createOpenaiProviderAdapter>): Promise<void> => {
    for await (const ev of adapter.chatStream(request)) void ev;
  };

  it('buffered chat, stream open and listing each map a zai 1308 429 to quota_exhausted with a parsed reset', async () => {
    const { client } = refuse(ZAI_1308);
    const adapter = createOpenaiProviderAdapter(zaiConfig, { httpClient: client });
    const expected = {
      kind: 'quota_exhausted',
      status: 429,
      planReset: { resetAt: Date.parse(RESET), window: 'short' },
    };
    await expect(adapter.chat(request)).rejects.toMatchObject(expected);
    await expect(drain(adapter)).rejects.toMatchObject(expected);
    await expect(adapter.listModels()).rejects.toMatchObject(expected);
  });

  it('the same responses without a dialect are rate_limit', async () => {
    const { client } = refuse(ZAI_1308);
    const adapter = createOpenaiProviderAdapter(config, { httpClient: client });
    for (const run of [
      () => adapter.chat(request),
      () => drain(adapter),
      () => adapter.listModels(),
    ]) {
      const err = await run().catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: 'rate_limit' });
      expect((err as { planReset?: unknown }).planReset).toBeUndefined();
    }
  });

  it('Retry-After: 120 gives a relative retryAfterMs and no resetAt, at any time', async () => {
    const body = JSON.stringify({ error: { code: '1313', message: 'Fair Usage Policy' } });
    const { client } = refuse(body, { 'Retry-After': '120' });
    const adapter = createOpenaiProviderAdapter(zaiConfig, { httpClient: client });
    jest.useFakeTimers();
    try {
      const seen: unknown[] = [];
      for (const at of ['2020-01-01T00:00:00Z', '2032-03-04T05:06:07Z']) {
        jest.setSystemTime(new Date(at));
        const err = await adapter.chat(request).catch((e: unknown) => e);
        expect(err).toMatchObject({ kind: 'risk_control', planReset: { retryAfterMs: 120_000 } });
        seen.push((err as { planReset: unknown }).planReset);
      }
      expect(seen[0]).toEqual(seen[1]);
      expect(seen[0]).not.toHaveProperty('resetAt');
    } finally {
      jest.useRealTimers();
    }
  });

  it('never reads Retry-After for an adapter without a dialect', async () => {
    const { client } = refuse(JSON.stringify({ error: { code: '1313' } }), {
      'Retry-After': '120',
    });
    const adapter = createOpenaiProviderAdapter(config, { httpClient: client });
    const err = await adapter.chat(request).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'rate_limit' });
    expect((err as { planReset?: unknown }).planReset).toBeUndefined();
  });

  it('an in-band SSE error event that carries a plan code keeps today stream classification', async () => {
    const sse =
      'data: ' +
      JSON.stringify({
        error: { type: 'rate_limit_error', code: '1308', message: 'Usage limit' },
      }) +
      '\n\ndata: [DONE]\n\n';
    const { client } = recordingClient(() => sseResponse(sse));
    const adapter = createOpenaiProviderAdapter(zaiConfig, { httpClient: client });
    const events: { type: string; diagnostic?: { kind?: string } }[] = [];
    for await (const ev of adapter.chatStream(request)) events.push(ev);
    const errEvent = events.find((e) => e.type === 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent!.diagnostic?.kind).toBe('rate_limit');
  });

  it('testConnection reports plan_inactive for a listing refused with 1309', async () => {
    const { client } = refuse(ZAI_1309);
    const adapter = createOpenaiProviderAdapter(zaiConfig, { httpClient: client });
    const result = await adapter.testConnection();
    expect(result).toMatchObject({ ok: false, kind: 'plan_inactive' });
  });

  it('a 401 from the listing stays auth under the dialect', async () => {
    const { client } = recordingClient(() => errorResponse(401, ZAI_1309));
    const adapter = createOpenaiProviderAdapter(zaiConfig, { httpClient: client });
    expect(await adapter.testConnection()).toMatchObject({ ok: false, kind: 'auth' });
    await expect(adapter.chat(request)).rejects.toMatchObject({ kind: 'auth' });
  });
});
