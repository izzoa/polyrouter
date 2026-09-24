// add-chatgpt-responses — the Responses provider adapter: OAuth-only construction,
// EXACTLY three identity-bearing headers (full-set equality doubles as the absence
// assertion for x-api-key / originator / session fingerprints), factory selection —
// and the VERIFIED-LIVE quirks: the wire is streaming-only, so chat() is
// stream-and-collect. add-live-subscription-models: listModels() reads the
// backend's own catalog and testConnection() is that listing — no model id anywhere.
import {
  CHATGPT_CATALOG_CLIENT_VERSION,
  createResponsesProviderAdapter,
  parseChatgptCatalog,
} from './responses-adapter';
import { createProviderAdapter } from './factory';
import { ProviderError } from './errors';
import type { ProviderConfig } from './adapter';
import type { NormalizedRequest } from '../proxy/translate';
import { recordingClient, sseResponse, errorResponse, jsonResponse } from './testkit.testkit';

const config: ProviderConfig = {
  protocol: 'openai_responses',
  baseUrl: 'https://chatgpt.example',
  credential: 'oat-access-token',
  kind: 'subscription',
  mode: 'selfhosted',
  authScheme: 'oauth_bearer',
  oauthAccountId: 'acct-123',
};

/** The live catalog's shape (verified 2026-09-24), trimmed to the fields we read. */
const CATALOG = {
  models: [
    {
      slug: 'gpt-6-luna',
      display_name: 'GPT-6-Luna',
      visibility: 'list',
      context_window: 272000,
      input_modalities: ['text', 'image'],
    },
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', input_modalities: ['text'] },
    { slug: 'codex-auto-review', visibility: 'hide' },
    { slug: 'gpt-withheld', visibility: 'none' },
    { display_name: 'no slug', visibility: 'list' },
    { slug: '', visibility: 'list' },
    { slug: 'gpt-legacy-shape' }, // no visibility field: offered
    'not-an-object',
  ],
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
    const body = JSON.parse(call.init.body as string) as Record<string, unknown>;
    expect(body['store']).toBe(false); // ALWAYS
    expect(body['stream']).toBe(true); // the wire refuses non-streaming (verified live)
    expect(body['model']).toBe('gpt-5.4-mini');
    expect('max_output_tokens' in body).toBe(false); // wire-rejected param (verified live)
  });

  it('chat() folds parallel tool calls and surfaces a mid-stream error as a typed failure', async () => {
    const toolStream = respSse([
      { type: 'response.created', response: { id: 'r', model: 'm' } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'it1', call_id: 'c1', name: 'a' },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'it1',
        output_index: 0,
        delta: '{"x":1}',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'function_call', id: 'it1', call_id: 'c1', name: 'a', arguments: '{"x":1}' },
      },
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

  it('construction is OAuth-only — typed credential errors otherwise, and no model id is needed', () => {
    expectCredentialError(
      () => createResponsesProviderAdapter({ ...config, authScheme: 'api_key' }),
      /oauth/i,
    );
    const { oauthAccountId: _a, ...noAccount } = config;
    expectCredentialError(() => createResponsesProviderAdapter(noAccount), /account id/i);
    // add-live-subscription-models: a build carries no probe model and needs none.
    expect(createResponsesProviderAdapter(config).protocol).toBe('openai_responses');
  });

  it('listModels() GETs the backend catalog with client_version and exactly the identity headers', async () => {
    const { client, calls } = recordingClient(() => jsonResponse(CATALOG));
    const adapter = createResponsesProviderAdapter(config, { httpClient: client });
    const models = await adapter.listModels();

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.init.method).toBe('GET');
    expect(call.url).toBe(
      `https://chatgpt.example/backend-api/codex/models?client_version=${CHATGPT_CATALOG_CLIENT_VERSION}`,
    );
    // Same identity set as chat (verified live): no originator, no UA, no session ids.
    const h = call.init.headers;
    const identity = Object.keys(h).filter((k) => !['Accept', 'Content-Type'].includes(k));
    expect(identity.sort()).toEqual(['Authorization', 'OpenAI-Beta', 'chatgpt-account-id']);
    expect(h['Authorization']).toBe('Bearer oat-access-token');
    expect(h['chatgpt-account-id']).toBe('acct-123');
    expect(models.map((m) => m.id)).toEqual(['gpt-6-luna', 'gpt-5.5', 'gpt-legacy-shape']);
  });

  it('parses the catalog defensively: offered entries only, the stated claim, nothing inferred', () => {
    const models = parseChatgptCatalog(CATALOG);
    expect(models).toEqual([
      {
        id: 'gpt-6-luna',
        displayName: 'GPT-6-Luna',
        capabilities: { contextWindow: 272000, supportsVision: true },
      },
      // A modalities array without image is an explicit "no vision"; tools and
      // reasoning are never stated by this catalog, so they stay absent.
      { id: 'gpt-5.5', displayName: 'GPT-5.5', capabilities: { supportsVision: false } },
      { id: 'gpt-legacy-shape' },
    ]);
    // A valid empty catalog is empty; a body without the array is shape DRIFT — typed.
    expect(parseChatgptCatalog({ models: [] })).toEqual([]);
    for (const drift of [{ models: 'nope' }, {}, null, 'text']) {
      expect(() => parseChatgptCatalog(drift)).toThrow(ProviderError);
    }
    expect(
      parseChatgptCatalog({
        models: [{ slug: 'x', context_window: -1, input_modalities: 'image' }],
      }),
    ).toEqual([{ id: 'x' }]);
    // A blank or whitespace slug names no model.
    expect(parseChatgptCatalog({ models: [{ slug: '  ' }, { slug: '' }] })).toEqual([]);
    // Duplicates collapse to the first.
    expect(
      parseChatgptCatalog({
        models: [
          { slug: 'x', display_name: 'A' },
          { slug: 'x', display_name: 'B' },
        ],
      }),
    ).toEqual([{ id: 'x', displayName: 'A' }]);
  });

  it('testConnection() is the catalog listing — never a chat, so a retired model cannot fail it', async () => {
    const { client, calls } = recordingClient(() => jsonResponse(CATALOG));
    const adapter = createResponsesProviderAdapter(config, { httpClient: client });
    await expect(adapter.testConnection()).resolves.toEqual({ ok: true, models: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.url).toContain('/backend-api/codex/models?client_version=');
    expect(calls.some((c) => c.url.includes('/responses'))).toBe(false);
  });

  it('testConnection() fails typed on catalog-shape drift — never "ok, 0 models"', async () => {
    const { client } = recordingClient(() => jsonResponse({ data: [] }));
    const result = await createResponsesProviderAdapter(config, {
      httpClient: client,
    }).testConnection();
    expect(result).toMatchObject({ ok: false, kind: 'unavailable' });
  });

  it('testConnection() maps a revoked credential to auth and a 403 to permission (never masked)', async () => {
    const { client } = recordingClient(() => errorResponse(401, '{"error":"invalid_token"}'));
    const result = await createResponsesProviderAdapter(config, {
      httpClient: client,
    }).testConnection();
    expect(result).toMatchObject({ ok: false, kind: 'auth' });
    expect(JSON.stringify(result)).not.toContain('oat-access-token');

    const { client: forbidden } = recordingClient(() => errorResponse(403, '{"detail":"no"}'));
    const denied = await createResponsesProviderAdapter(config, {
      httpClient: forbidden,
    }).testConnection();
    expect(denied).toMatchObject({ ok: false, kind: 'permission' });
  });

  it('the factory selects the Responses adapter for openai_responses', () => {
    expect(createProviderAdapter(config).protocol).toBe('openai_responses');
  });
});
