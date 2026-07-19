// add-chatgpt-responses — the Responses provider adapter: OAuth-only construction,
// EXACTLY three identity-bearing headers (full-set equality doubles as the absence
// assertion for x-api-key / originator / session fingerprints), typed listModels
// reject, the designated probe, factory selection — and the VERIFIED-LIVE quirks:
// the wire is streaming-only, so chat() is stream-and-collect.
import { createResponsesProviderAdapter } from './responses-adapter';
import { createProviderAdapter } from './factory';
import { ProviderError } from './errors';
import type { ProviderConfig } from './adapter';
import type { NormalizedRequest } from '../proxy/translate';
import { recordingClient, sseResponse, errorResponse } from './testkit.testkit';

const config: ProviderConfig = {
  protocol: 'openai_responses',
  baseUrl: 'https://chatgpt.example',
  credential: 'oat-access-token',
  kind: 'subscription',
  mode: 'selfhosted',
  authScheme: 'oauth_bearer',
  oauthAccountId: 'acct-123',
  probeModel: 'gpt-5.4-mini',
};

const request: NormalizedRequest = {
  model: 'gpt-5.4-mini',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  params: {},
};

/** Responses-shaped SSE (the live wire uses `event:` + `data:` frames). */
const respSse = (events: readonly unknown[]): string =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';

const OK_STREAM = respSse([
  { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.4-mini' } },
  { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, delta: 'Hello!' },
  { type: 'response.completed', response: { usage: { input_tokens: 3, output_tokens: 1 } } },
]);

function expectCredentialError(fn: () => unknown, match: RegExp): void {
  try {
    fn();
    throw new Error('expected a ProviderError');
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('credential');
    expect((err as ProviderError).message).toMatch(match);
  }
}

describe('Responses provider adapter (add-chatgpt-responses)', () => {
  it('chat() rides the STREAMING wire (stream:true, no cap params) and folds the events', async () => {
    const { client, calls } = recordingClient(() => sseResponse(OK_STREAM));
    const adapter = createResponsesProviderAdapter(config, { httpClient: client });
    const res = await adapter.chat(request);

    expect(res.content).toEqual([{ type: 'text', text: 'Hello!' }]);
    expect(res.stopReason).toBe('stop');
    expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 1 });
    const call = calls[0]!;
    expect(call.url).toBe('https://chatgpt.example/backend-api/codex/responses');
    expect(call.init.method).toBe('POST');
    const h = call.init.headers;
    // Full-set equality IS the absence assertion: nothing else identity-bearing —
    // no x-api-key, no originator, no session ids, no anthropic-* — can be present.
    // (Accept is the SSE content negotiation of the streaming-only wire.)
    expect(Object.keys(h).sort()).toEqual([
      'Accept',
      'Authorization',
      'Content-Type',
      'OpenAI-Beta',
      'chatgpt-account-id',
    ]);
    expect(h['Authorization']).toBe('Bearer oat-access-token');
    expect(h['chatgpt-account-id']).toBe('acct-123');
    expect(h['OpenAI-Beta']).toBe('responses=experimental');
    const body = JSON.parse(call.init.body!) as Record<string, unknown>;
    expect(body['store']).toBe(false); // ALWAYS
    expect(body['stream']).toBe(true); // the wire refuses non-streaming (verified live)
    expect(body['model']).toBe('gpt-5.4-mini');
    expect('max_output_tokens' in body).toBe(false); // wire-rejected param (verified live)
  });

  it('chat() folds parallel tool calls and surfaces a mid-stream error as a typed failure', async () => {
    const toolStream = respSse([
      { type: 'response.created', response: { id: 'r', model: 'm' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'it1', call_id: 'c1', name: 'a' } },
      { type: 'response.function_call_arguments.delta', item_id: 'it1', output_index: 0, delta: '{"x":1}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'it1', call_id: 'c1', name: 'a', arguments: '{"x":1}' } },
      { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 2 } } },
    ]);
    const { client } = recordingClient(() => sseResponse(toolStream));
    const adapter = createResponsesProviderAdapter(config, { httpClient: client });
    const res = await adapter.chat(request);
    expect(res.content).toEqual([{ type: 'tool_use', id: 'c1', name: 'a', input: { x: 1 } }]);
    expect(res.stopReason).toBe('tool_use');

    // A truncated stream (EOF without terminal) must NOT fold into a silent partial.
    const truncated = respSse([
      { type: 'response.created', response: {} },
      { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, delta: 'par' },
    ]);
    const { client: truncClient } = recordingClient(() => sseResponse(truncated));
    const truncAdapter = createResponsesProviderAdapter(config, { httpClient: truncClient });
    await expect(truncAdapter.chat(request)).rejects.toBeInstanceOf(ProviderError);
  });

  it('construction is OAuth-only and fully configured — typed credential errors otherwise', () => {
    expectCredentialError(
      () => createResponsesProviderAdapter({ ...config, authScheme: 'api_key' }),
      /oauth/i,
    );
    const { oauthAccountId: _a, ...noAccount } = config;
    expectCredentialError(() => createResponsesProviderAdapter(noAccount), /account id/i);
    const { probeModel: _p, ...noProbe } = config;
    expectCredentialError(() => createResponsesProviderAdapter(noProbe), /probe model/i);
  });

  it('listModels() rejects typed (bad_request) — never an implicit empty list', async () => {
    const { client, calls } = recordingClient(() => sseResponse(OK_STREAM));
    const adapter = createResponsesProviderAdapter(config, { httpClient: client });
    await expect(adapter.listModels()).rejects.toMatchObject({ kind: 'bad_request' });
    expect(calls).toHaveLength(0); // no network call for an unsupported surface
  });

  it('testConnection() runs the streaming probe against the preset probeModel', async () => {
    const { client, calls } = recordingClient(() => sseResponse(OK_STREAM));
    const adapter = createResponsesProviderAdapter(config, { httpClient: client });
    await expect(adapter.testConnection()).resolves.toEqual({ ok: true, models: 0 });
    const body = JSON.parse(calls[0]!.init.body!) as Record<string, unknown>;
    expect(body['model']).toBe('gpt-5.4-mini');
    expect(body['stream']).toBe(true);
    expect(body['store']).toBe(false);
    expect('max_output_tokens' in body).toBe(false);
  });

  it('testConnection() maps a revoked credential to a typed auth failure (never masked)', async () => {
    const { client } = recordingClient(() => errorResponse(401, '{"error":"invalid_token"}'));
    const adapter = createResponsesProviderAdapter(config, { httpClient: client });
    const result = await adapter.testConnection();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('auth');
  });

  it('the factory selects the Responses adapter for openai_responses', () => {
    expect(createProviderAdapter(config).protocol).toBe('openai_responses');
  });
});
