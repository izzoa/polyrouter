// allow-preset-client-identity — preset client-identity headers ride the extra-headers seam
// (provider-adapters "Preset client-identity headers ride the extra-headers seam…", design D5).
// One case per spec scenario: reach every call of every protocol, never displace a protocol
// header (case-insensitively), a declared User-Agent is the only one, no extras = no change.
import { POLYROUTER_USER_AGENT } from '@polyrouter/shared/server';
import { createAnthropicProviderAdapter } from './anthropic-adapter';
import { createOpenaiProviderAdapter } from './openai-adapter';
import { createResponsesProviderAdapter } from './responses-adapter';
import type { ProviderAdapter, ProviderConfig } from './adapter';
import type { BatchTransport } from './batch/transport';
import type { BatchAdapter } from './batch';
import type { HttpInit } from './http';
import {
  recordingClient,
  jsonResponse,
  sseResponse,
  oaiSse,
  antSse,
  type RecordedCall,
} from './testkit.testkit';
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

type Extra = Record<string, string>;

interface Case {
  readonly name: string;
  readonly build: (
    extraHeaders: Extra | undefined,
    httpClient: ReturnType<typeof recordingClient>['client'],
    batch?: (t: BatchTransport) => BatchAdapter,
  ) => ProviderAdapter;
  readonly respond: (url: string, init: HttpInit) => ReturnType<typeof jsonResponse>;
  /** The header names (lower-case) this adapter itself sets on a streaming POST. */
  readonly ownStreamHeaders: readonly string[];
  /** The header names this adapter itself sets on a non-streaming POST. */
  readonly ownPostHeaders: readonly string[];
  /** The header names this adapter itself sets on a listing GET. */
  readonly ownGetHeaders: readonly string[];
}

const withExtra = (extraHeaders?: Extra): Partial<ProviderConfig> =>
  extraHeaders !== undefined ? { extraHeaders } : {};

const oaiConfig = (extraHeaders?: Extra): ProviderConfig => ({
  protocol: 'openai_compatible',
  baseUrl: 'https://api.openai.example/v1',
  credential: 'sk-secret',
  kind: 'api_key',
  mode: 'cloud',
  ...withExtra(extraHeaders),
});
const antConfig = (extra: Partial<ProviderConfig>, extraHeaders?: Extra): ProviderConfig => ({
  protocol: 'anthropic_compatible',
  baseUrl: 'https://api.anthropic.example',
  credential: 'sk-ant',
  kind: 'api_key',
  mode: 'cloud',
  defaultMaxOutputTokens: 4096,
  ...extra,
  ...withExtra(extraHeaders),
});
const respConfig = (extraHeaders?: Extra): ProviderConfig => ({
  protocol: 'openai_responses',
  baseUrl: 'https://chatgpt.example',
  credential: 'oat-access',
  kind: 'subscription',
  mode: 'selfhosted',
  authScheme: 'oauth_bearer',
  oauthAccountId: 'acct-1',
  ...withExtra(extraHeaders),
});

const isStream = (init: HttpInit): boolean => init.headers['Accept'] === 'text/event-stream';

const antRespond: Case['respond'] = (url, init) =>
  init.method === 'GET'
    ? jsonResponse({ data: [{ id: 'm1' }], has_more: false, last_id: 'm1' })
    : isStream(init)
      ? sseResponse(ANT_STREAM)
      : jsonResponse(ANT_CHAT);

const CASES: Case[] = [
  {
    name: 'OpenAI-compatible',
    build: (x, httpClient, batch) =>
      createOpenaiProviderAdapter(oaiConfig(x), {
        httpClient,
        ...(batch !== undefined ? { batch } : {}),
      }),
    respond: (_url, init) =>
      init.method === 'GET'
        ? jsonResponse({ data: [{ id: 'm' }] })
        : isStream(init)
          ? sseResponse(OAI_STREAM)
          : jsonResponse(OAI_CHAT),
    ownStreamHeaders: ['authorization', 'content-type', 'accept', 'user-agent'],
    ownPostHeaders: ['authorization', 'content-type', 'user-agent'],
    ownGetHeaders: ['authorization', 'user-agent'],
  },
  {
    name: 'Anthropic-compatible (api_key)',
    build: (x, httpClient, batch) =>
      createAnthropicProviderAdapter(antConfig({}, x), {
        httpClient,
        ...(batch !== undefined ? { batch } : {}),
      }),
    respond: antRespond,
    ownStreamHeaders: ['x-api-key', 'anthropic-version', 'content-type', 'accept', 'user-agent'],
    ownPostHeaders: ['x-api-key', 'anthropic-version', 'content-type', 'user-agent'],
    ownGetHeaders: ['x-api-key', 'anthropic-version', 'user-agent'],
  },
  {
    name: 'Anthropic-compatible (oauth_bearer)',
    build: (x, httpClient, batch) =>
      createAnthropicProviderAdapter(
        antConfig({ authScheme: 'oauth_bearer', oauthBeta: 'b-1', kind: 'subscription' }, x),
        { httpClient, ...(batch !== undefined ? { batch } : {}) },
      ),
    respond: antRespond,
    ownStreamHeaders: [
      'authorization',
      'anthropic-beta',
      'anthropic-version',
      'content-type',
      'accept',
      'user-agent',
    ],
    ownPostHeaders: [
      'authorization',
      'anthropic-beta',
      'anthropic-version',
      'content-type',
      'user-agent',
    ],
    ownGetHeaders: ['authorization', 'anthropic-beta', 'anthropic-version', 'user-agent'],
  },
  {
    name: 'Responses',
    build: (x, httpClient, batch) =>
      createResponsesProviderAdapter(respConfig(x), {
        httpClient,
        ...(batch !== undefined ? { batch } : {}),
      }),
    respond: (_url, init) =>
      init.method === 'GET' ? jsonResponse({ models: [{ slug: 'm' }] }) : sseResponse(RESP_STREAM),
    ownStreamHeaders: [
      'authorization',
      'chatgpt-account-id',
      'openai-beta',
      'content-type',
      'accept',
      'user-agent',
    ],
    // The Responses wire is streaming-only: buffered chat rides the SSE path.
    ownPostHeaders: [
      'authorization',
      'chatgpt-account-id',
      'openai-beta',
      'content-type',
      'accept',
      'user-agent',
    ],
    ownGetHeaders: ['authorization', 'chatgpt-account-id', 'openai-beta', 'user-agent'],
  },
];

async function exercise(adapter: ProviderAdapter): Promise<void> {
  await adapter.chat(request);
  for await (const ev of adapter.chatStream(request)) void ev;
  await adapter.listModels();
  await adapter.testConnection();
}

const keysLower = (h: Record<string, string>): string[] =>
  Object.keys(h)
    .map((k) => k.toLowerCase())
    .sort();
const entriesNamed = (h: Record<string, string>, lower: string): [string, string][] =>
  Object.entries(h).filter(([k]) => k.toLowerCase() === lower);

async function record(c: Case, extra: Extra | undefined): Promise<RecordedCall[]> {
  const { client, calls } = recordingClient(c.respond);
  await exercise(c.build(extra, client));
  expect(calls.length).toBeGreaterThanOrEqual(4);
  return calls;
}

describe('preset client-identity headers ride the extra-headers seam', () => {
  const IDENTITY: Extra = { 'X-Fixture-Client': 'polyrouter-test', 'X-Other': 'o' };

  for (const c of CASES) {
    describe(c.name, () => {
      it('identity headers reach chat, chatStream, listModels and testConnection', async () => {
        const calls = await record(c, IDENTITY);
        const gets = calls.filter((x) => x.init.method === 'GET');
        const streams = calls.filter((x) => x.init.method === 'POST' && isStream(x.init));
        // chat + chatStream (the Responses wire streams both) + listing + Test's listing.
        expect(gets.length).toBeGreaterThanOrEqual(2);
        expect(streams.length).toBeGreaterThanOrEqual(1);
        for (const call of calls) {
          expect(call.init.headers['X-Fixture-Client']).toBe('polyrouter-test');
          expect(call.init.headers['X-Other']).toBe('o');
        }
      });

      it('case-variant protocol headers each leave exactly one value, the adapter’s own', async () => {
        const base = await record(c, undefined);
        const clash: Extra = {
          authorization: 'Bearer evil',
          'X-API-KEY': 'evil',
          'content-type': 'text/evil',
          accept: 'text/evil',
          'anthropic-version': 'evil',
          'openai-beta': 'evil',
          'CHATGPT-ACCOUNT-ID': 'evil',
          'x-keep': 'kept',
        };
        const withClash = await record(c, clash);
        expect(withClash).toHaveLength(base.length);
        const asserted = new Set<string>();
        withClash.forEach((call, i) => {
          const own = base[i]!.init.headers;
          expect(call.init.headers['x-keep']).toBe('kept');
          for (const [ownName, ownValue] of Object.entries(own)) {
            const lower = ownName.toLowerCase();
            if (lower === 'user-agent') continue;
            expect(entriesNamed(call.init.headers, lower)).toEqual([[ownName, ownValue]]);
            asserted.add(lower);
          }
          // A clash name this protocol does not set (x-api-key on a Bearer adapter) is not
          // displaced: it is not a protocol header HERE, and validateClientIdentity's reserved
          // set is what keeps it out of a declaration. The value never lands on an own name.
          const ownLower = new Set(Object.keys(own).map((k) => k.toLowerCase()));
          for (const [k, v] of Object.entries(call.init.headers)) {
            if (v.includes('evil')) expect(ownLower.has(k.toLowerCase())).toBe(false);
          }
        });
        // Not vacuous: every protocol header this adapter sets was actually checked.
        const own = new Set([...c.ownStreamHeaders, ...c.ownPostHeaders, ...c.ownGetHeaders]);
        own.delete('user-agent');
        expect([...asserted].sort()).toEqual([...own].sort());
      });

      it.each([
        ['User-Agent', 'User-Agent'],
        ['user-agent', 'user-agent'],
        ['USER-AGENT', 'USER-AGENT'],
      ])(
        'a declared %s is the only User-Agent sent (no polyrouter or library UA beside it)',
        async (name) => {
          const calls = await record(c, { [name]: 'fixture-client/1.0' });
          for (const call of calls) {
            expect(entriesNamed(call.init.headers, 'user-agent')).toEqual([
              ['User-Agent', 'fixture-client/1.0'],
            ]);
            expect(JSON.stringify(call.init.headers)).not.toContain('polyrouter/');
          }
        },
      );

      it('an adapter with no extra headers sends exactly the headers it sent before', async () => {
        const calls = await record(c, undefined);
        for (const call of calls) {
          const expected =
            call.init.method === 'GET'
              ? c.ownGetHeaders
              : isStream(call.init)
                ? c.ownStreamHeaders
                : c.ownPostHeaders;
          expect(keysLower(call.init.headers)).toEqual([...expected].sort());
          expect(call.init.headers['User-Agent']).toBe(POLYROUTER_USER_AGENT);
        }
      });

      it('the batch transport carries the identity headers, each protocol header single-valued', () => {
        let transport: BatchTransport | undefined;
        let baseline: BatchTransport | undefined;
        const { client } = recordingClient(c.respond);
        c.build(undefined, client, (t) => {
          baseline = t;
          return {} as unknown as BatchAdapter;
        });
        c.build(
          {
            ...IDENTITY,
            authorization: 'Bearer evil',
            'X-API-KEY': 'evil',
            'CONTENT-TYPE': 'text/evil',
          },
          client,
          (t) => {
            transport = t;
            return {} as unknown as BatchAdapter;
          },
        );
        expect(transport).toBeDefined();
        for (const json of [true, false]) {
          const h = transport!.headers(json);
          const own = baseline!.headers(json);
          expect(h['X-Fixture-Client']).toBe('polyrouter-test');
          expect(h['X-Other']).toBe('o');
          // Every header the adapter itself sets stays single-valued, with its own value.
          for (const [ownName, ownValue] of Object.entries(own)) {
            if (ownName.toLowerCase() === 'user-agent') continue;
            expect(entriesNamed(h, ownName.toLowerCase())).toEqual([[ownName, ownValue]]);
          }
          if (json)
            expect(entriesNamed(h, 'content-type')).toEqual([['Content-Type', 'application/json']]);
        }
      });
    });
  }
});
