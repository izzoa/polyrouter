// add-honest-user-agent — every provider request carries exactly one
// `User-Agent: polyrouter/<version>`; a UA on the `extraHeaders` identity seam
// replaces it (once); a UA from any other layer is dropped.
import { POLYROUTER_USER_AGENT } from '@polyrouter/shared/server';
import { createAnthropicProviderAdapter } from './anthropic-adapter';
import { createOpenaiProviderAdapter } from './openai-adapter';
import { createHttpProviderAdapter, parseModelList } from './http-adapter';
import { openaiAdapter } from '../proxy/translate';
import { createResponsesProviderAdapter } from './responses-adapter';
import type { ProviderAdapter, ProviderConfig } from './adapter';
import type { HttpInit } from './http';
import { recordingClient, jsonResponse, sseResponse, oaiSse, antSse } from './testkit.testkit';
import type { NormalizedRequest } from '../proxy/translate';

const request: NormalizedRequest = {
  model: 'm',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  params: {},
};

const OAI_CHAT = {
  id: 'c',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
};
const OAI_STREAM = oaiSse([
  {
    id: 's',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }],
  },
  {
    id: 's',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  },
]);
const ANT_CHAT = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'm',
  content: [{ type: 'text', text: 'x' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};
const ANT_STREAM = antSse([
  {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'm',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);
const RESP_STREAM =
  [
    { type: 'response.created', response: { id: 'r', model: 'm' } },
    { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, delta: 'x' },
    {
      type: 'response.completed',
      response: {
        id: 'r',
        model: 'm',
        status: 'completed',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ]
    .map((e) => `data: ${JSON.stringify(e)}\n\n`)
    .join('') + 'data: [DONE]\n\n';

interface Case {
  readonly name: string;
  readonly build: (
    extraHeaders: Record<string, string> | undefined,
    httpClient: ReturnType<typeof recordingClient>['client'],
  ) => ProviderAdapter;
  readonly respond: (url: string, init: HttpInit) => ReturnType<typeof jsonResponse>;
  readonly streams: boolean;
}

const oaiConfig = (extraHeaders?: Record<string, string>): ProviderConfig => ({
  protocol: 'openai_compatible',
  baseUrl: 'https://api.openai.example/v1',
  credential: 'sk-secret',
  kind: 'api_key',
  mode: 'cloud',
  ...(extraHeaders !== undefined ? { extraHeaders } : {}),
});
const antConfig = (
  extra: Partial<ProviderConfig>,
  extraHeaders?: Record<string, string>,
): ProviderConfig => ({
  protocol: 'anthropic_compatible',
  baseUrl: 'https://api.anthropic.example',
  credential: 'sk-ant',
  kind: 'api_key',
  mode: 'cloud',
  defaultMaxOutputTokens: 4096,
  ...extra,
  ...(extraHeaders !== undefined ? { extraHeaders } : {}),
});
const respConfig = (extraHeaders?: Record<string, string>): ProviderConfig => ({
  protocol: 'openai_responses',
  baseUrl: 'https://chatgpt.example',
  credential: 'oat-access',
  kind: 'subscription',
  mode: 'selfhosted',
  authScheme: 'oauth_bearer',
  oauthAccountId: 'acct-1',
  ...(extraHeaders !== undefined ? { extraHeaders } : {}),
});

const isStream = (init: HttpInit): boolean => init.headers['Accept'] === 'text/event-stream';

const CASES: Case[] = [
  {
    name: 'OpenAI-compatible',
    streams: true,
    build: (x, httpClient) => createOpenaiProviderAdapter(oaiConfig(x), { httpClient }),
    respond: (url, init) =>
      init.method === 'GET'
        ? jsonResponse({ data: [{ id: 'm' }] })
        : isStream(init)
          ? sseResponse(OAI_STREAM)
          : jsonResponse(OAI_CHAT),
  },
  ...(
    [
      ['Anthropic-compatible (api_key)', {}],
      [
        'Anthropic-compatible (oauth_bearer)',
        { authScheme: 'oauth_bearer', oauthBeta: 'b-1', kind: 'subscription' },
      ],
    ] as const
  ).map(([name, extra]): Case => ({
    name,
    streams: true,
    build: (x, httpClient) =>
      createAnthropicProviderAdapter(antConfig(extra as Partial<ProviderConfig>, x), {
        httpClient,
      }),
    respond: (url, init) =>
      init.method === 'GET'
        ? url.includes('after_id=m1')
          ? jsonResponse({ data: [{ id: 'm2' }], has_more: false, last_id: 'm2' })
          : jsonResponse({ data: [{ id: 'm1' }], has_more: true, last_id: 'm1' })
        : isStream(init)
          ? sseResponse(ANT_STREAM)
          : jsonResponse(ANT_CHAT),
  })),
  {
    name: 'Responses',
    streams: true,
    build: (x, httpClient) => createResponsesProviderAdapter(respConfig(x), { httpClient }),
    respond: (_url, init) =>
      init.method === 'GET' ? jsonResponse({ models: [{ slug: 'm' }] }) : sseResponse(RESP_STREAM),
  },
];

async function exercise(adapter: ProviderAdapter): Promise<void> {
  await adapter.chat(request);
  for await (const ev of adapter.chatStream(request)) void ev;
  await adapter.listModels();
  await adapter.testConnection();
}

/** Every `user-agent` key (any case) in a recorded header record. */
const uaEntries = (h: Record<string, string>): [string, string][] =>
  Object.entries(h).filter(([k]) => k.toLowerCase() === 'user-agent');

describe('provider requests send exactly one User-Agent (outbound-user-agent)', () => {
  for (const c of CASES) {
    describe(c.name, () => {
      it('chat, chatStream, listModels and testConnection send polyrouter/<version>', async () => {
        const { client, calls } = recordingClient(c.respond);
        await exercise(c.build(undefined, client));
        // chat + stream + listing (paginated for Anthropic) + the test's listing.
        expect(calls.length).toBeGreaterThanOrEqual(4);
        for (const call of calls) {
          expect(uaEntries(call.init.headers)).toEqual([['User-Agent', POLYROUTER_USER_AGENT]]);
        }
        expect(POLYROUTER_USER_AGENT).toMatch(/^polyrouter\/\d+\.\d+\.\d+/);
      });

      it.each([
        ['lower-case key', { 'user-agent': 'identity/1.0', 'x-custom': 'v1' }, true],
        ['upper-case key', { 'USER-AGENT': 'identity/1.0' }, false],
      ])(
        'a User-Agent on the extraHeaders identity seam (%s) replaces polyrouter’s exactly once',
        async (_label, extraHeaders, hasCustom) => {
          const { client, calls } = recordingClient(c.respond);
          await exercise(c.build(extraHeaders, client));
          expect(calls.length).toBeGreaterThanOrEqual(4);
          for (const call of calls) {
            expect(uaEntries(call.init.headers)).toEqual([['User-Agent', 'identity/1.0']]);
            expect(Object.values(call.init.headers).join('|')).not.toContain('polyrouter/');
            if (hasCustom) expect(call.init.headers['x-custom']).toBe('v1');
          }
        },
      );
    });
  }

  it('a paginated Anthropic listing sends the UA on every page', async () => {
    const { client, calls } = recordingClient(CASES[1]!.respond);
    await CASES[1]!.build(undefined, client).listModels();
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(uaEntries(call.init.headers)).toEqual([['User-Agent', POLYROUTER_USER_AGENT]]);
    }
  });

  // Attribution headers have fixed, distinct names (never a UA), so the dropped-UA scenario is
  // exercised through the authentication layer, the only other layer that can carry arbitrary keys.
  it.each(['user-agent', 'USER-AGENT', 'User-Agent'])(
    'a %s key from the authentication layer is dropped, polyrouter’s is sent once',
    async (key) => {
      const { client, calls } = recordingClient(CASES[0]!.respond);
      const adapter = createHttpProviderAdapter(
        oaiConfig(),
        { httpClient: client },
        {
          protocol: 'openai_compatible',
          translate: openaiAdapter,
          chatPath: '/chat/completions',
          modelsPath: '/models',
          authHeaders: () => ({ [key]: 'custom/1.0', Authorization: 'Bearer x' }),
          parseModels: (json) => parseModelList(json),
        },
      );
      await exercise(adapter);
      expect(calls.length).toBeGreaterThanOrEqual(4);
      for (const call of calls) {
        expect(uaEntries(call.init.headers)).toEqual([['User-Agent', POLYROUTER_USER_AGENT]]);
        expect(Object.values(call.init.headers).join('|')).not.toContain('custom/1.0');
        expect(call.init.headers['Authorization']).toBe('Bearer x');
      }
    },
  );
});
