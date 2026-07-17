import { createAnthropicProviderAdapter } from './anthropic-adapter';
import type { NormalizedRequest } from '../proxy/translate';
import {
  recordingClient,
  jsonResponse,
  errorResponse,
  sseResponse,
  antSse,
} from './testkit.testkit';

const config = {
  protocol: 'anthropic_compatible' as const,
  baseUrl: 'https://api.anthropic.example',
  credential: 'sk-ant-secret',
  kind: 'api_key' as const,
  mode: 'cloud' as const,
  defaultMaxOutputTokens: 4096,
  extraHeaders: { 'x-custom': 'v1' },
};

const request: NormalizedRequest = {
  model: 'claude-sonnet-4-5',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  params: {}, // no maxOutputTokens → default kicks in
};

const ANT_RESPONSE = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-5',
  content: [{ type: 'text', text: 'Hello!' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 2 },
};

describe('Anthropic provider adapter', () => {
  it('POSTs to /v1/messages with x-api-key + version and the max_tokens default', async () => {
    const { client, calls } = recordingClient(() => jsonResponse(ANT_RESPONSE));
    const adapter = createAnthropicProviderAdapter(config, { httpClient: client });
    const res = await adapter.chat(request);

    expect(res.content).toEqual([{ type: 'text', text: 'Hello!' }]);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.anthropic.example/v1/messages');
    expect(call.init.headers['x-api-key']).toBe('sk-ant-secret');
    expect(call.init.headers['anthropic-version']).toBe('2023-06-01');
    expect(call.init.headers['x-custom']).toBe('v1');
    const body = JSON.parse(call.init.body!) as { max_tokens: number };
    expect(body.max_tokens).toBe(4096);
  });

  it('lists models from /v1/models with display names', async () => {
    const { client, calls } = recordingClient(() =>
      jsonResponse({ data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }] }),
    );
    const adapter = createAnthropicProviderAdapter(config, { httpClient: client });
    const models = await adapter.listModels();
    expect(models[0]).toEqual({ id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5' });
    expect(calls[0]!.url).toBe('https://api.anthropic.example/v1/models');
  });

  it('follows /v1/models cursor pagination (has_more + last_id) to a complete catalog', async () => {
    // Page 1: has_more + last_id='m1'; page 2 (requested with after_id=m1): no more.
    const { client, calls } = recordingClient((url) =>
      url.includes('after_id=m1')
        ? jsonResponse({ data: [{ id: 'm2', display_name: 'M2' }], has_more: false, last_id: 'm2' })
        : jsonResponse({ data: [{ id: 'm1', display_name: 'M1' }], has_more: true, last_id: 'm1' }),
    );
    const adapter = createAnthropicProviderAdapter(config, { httpClient: client });
    const models = await adapter.listModels();
    expect(models.map((m) => m.id)).toEqual(['m1', 'm2']); // both pages accumulated
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://api.anthropic.example/v1/models');
    expect(calls[1]!.url).toBe('https://api.anthropic.example/v1/models?after_id=m1'); // cursor carried
  });

  it('stops paging when has_more is false (single fetch)', async () => {
    const { calls, client } = recordingClient(() =>
      jsonResponse({ data: [{ id: 'only' }], has_more: false }),
    );
    const adapter = createAnthropicProviderAdapter(config, { httpClient: client });
    const models = await adapter.listModels();
    expect(models.map((m) => m.id)).toEqual(['only']);
    expect(calls).toHaveLength(1); // no phantom second page
  });

  it('stops on a stuck/repeating cursor instead of crawling to the page bound', async () => {
    let n = 0;
    const { calls, client } = recordingClient(() => {
      n += 1;
      // Always claims more, but never advances the cursor — a buggy/hostile endpoint.
      return jsonResponse({ data: [{ id: `m${n}` }], has_more: true, last_id: 'STUCK' });
    });
    const adapter = createAnthropicProviderAdapter(config, { httpClient: client });
    await adapter.listModels();
    expect(calls.length).toBeLessThanOrEqual(2); // cursor cycle detected — not 50 requests
  });

  it('streams events whose text concatenates', async () => {
    const events = [
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: 'm',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-5',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 0 },
          },
        },
      },
      {
        event: 'content_block_start',
        data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      },
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
      },
      {
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
      },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      {
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 2 },
        },
      },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ];
    const { client } = recordingClient(() => sseResponse(antSse(events)));
    const adapter = createAnthropicProviderAdapter(config, { httpClient: client });
    let text = '';
    for await (const ev of adapter.chatStream(request)) {
      if (ev.type === 'text_delta') text += ev.text;
    }
    expect(text).toBe('Hello');
  });

  it('maps a 429 to a typed rate_limit error', async () => {
    const { client } = recordingClient(() => errorResponse(429, 'slow down'));
    const adapter = createAnthropicProviderAdapter(config, { httpClient: client });
    await expect(adapter.chat(request)).rejects.toMatchObject({ kind: 'rate_limit' });
  });
});
