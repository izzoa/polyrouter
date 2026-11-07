// add-subscription-quota-display (tasks 3.1-3.2) — the adapter's usage seam: `reportUsage` at the
// four response sites, contained, gated on BOTH a dialect and a callback, and the OpenCode Go
// body readers (buffered JSON, pass-through stream tap) that never alter what translate sees.
import { createAnthropicProviderAdapter } from './anthropic-adapter';
import { createOpenaiProviderAdapter } from './openai-adapter';
import { createResponsesProviderAdapter } from './responses-adapter';
import type { CallContext, ProviderAdapter, ProviderConfig } from './adapter';
import type { HttpResponse } from './http';
import type { PlanUsageObservation } from './plan-usage';
import {
  antSse,
  errorResponse,
  jsonResponse,
  oaiSse,
  recordingClient,
  sseResponse,
} from './testkit.testkit';
import type { NormalizedRequest, NormalizedStreamEvent } from '../proxy/translate';

const request: NormalizedRequest = {
  model: 'm',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  params: {},
};

const antConfig = (extra: Partial<ProviderConfig> = {}): ProviderConfig => ({
  protocol: 'anthropic_compatible',
  baseUrl: 'https://api.anthropic.example',
  credential: 'sk-ant',
  kind: 'subscription',
  mode: 'cloud',
  defaultMaxOutputTokens: 4096,
  ...extra,
});
const oaiConfig = (extra: Partial<ProviderConfig> = {}): ProviderConfig => ({
  protocol: 'openai_compatible',
  baseUrl: 'https://api.openai.example/v1',
  credential: 'sk-oai',
  kind: 'subscription',
  mode: 'cloud',
  ...extra,
});

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** A Claude response family: 5h at 50% and weekly at 20%, both with a plausible reset. */
function claudeHeaders(): Record<string, string> {
  return {
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.5',
    'anthropic-ratelimit-unified-5h-reset': String(nowSec() + 3600),
    'anthropic-ratelimit-unified-7d-utilization': '0.2',
    'anthropic-ratelimit-unified-7d-reset': String(nowSec() + 86_400),
  };
}

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
const ANT_MODELS = { data: [{ id: 'claude-x' }], has_more: false };

const OAI_CHAT = {
  id: 'c',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
};

function usageProbe(): { seen: PlanUsageObservation[]; ctx: CallContext } {
  const seen: PlanUsageObservation[] = [];
  return { seen, ctx: { onPlanUsage: (o) => seen.push(o) } };
}

async function drain(iter: AsyncIterable<NormalizedStreamEvent>): Promise<NormalizedStreamEvent[]> {
  const out: NormalizedStreamEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

function claudeAdapter(
  responder: Parameters<typeof recordingClient>[0],
  extra: Partial<ProviderConfig> = { usageDialect: 'anthropic_unified' },
): ProviderAdapter {
  const { client } = recordingClient(responder);
  return createAnthropicProviderAdapter(antConfig(extra), { httpClient: client });
}

describe('plan-usage reporting in the shared HTTP adapter (design D2)', () => {
  it('fires once per site with the parsed observation: buffered chat, stream open, listing page, 429', async () => {
    // buffered chat
    const chat = usageProbe();
    await claudeAdapter(() => jsonResponse(ANT_CHAT, 200, claudeHeaders())).chat(request, chat.ctx);
    expect(chat.seen).toHaveLength(1);
    expect(chat.seen[0]!.windows.map((w) => w.key)).toEqual(['account:5h', 'account:weekly']);
    expect(chat.seen[0]!.windows[0]!.usedPercent).toBe(50);
    expect(chat.seen[0]!.billing).toBe('plan');

    // stream open
    const stream = usageProbe();
    await drain(
      claudeAdapter(() => sseResponse(ANT_STREAM, { headers: claudeHeaders() })).chatStream(
        request,
        stream.ctx,
      ),
    );
    expect(stream.seen).toHaveLength(1);
    expect(stream.seen[0]!.windows[0]!.usedPercent).toBe(50);

    // listing page
    const list = usageProbe();
    await claudeAdapter(() => jsonResponse(ANT_MODELS, 200, claudeHeaders())).listModels(list.ctx);
    expect(list.seen).toHaveLength(1);
    expect(list.seen[0]!.windows[0]!.usedPercent).toBe(50);

    // a 429: reported BEFORE the typed error is raised
    const refused = usageProbe();
    const err: unknown = await claudeAdapter(() =>
      errorResponse(429, '{"error":{"type":"rate_limit_error","message":"slow down"}}', {
        ...claudeHeaders(),
        'anthropic-ratelimit-unified-status': 'rejected',
      }),
    )
      .chat(request, refused.ctx)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'rate_limit' });
    expect(refused.seen).toHaveLength(1);
    expect(refused.seen[0]!.windows).toHaveLength(2);
  });

  it('reports each listing page once, across a paginated listing', async () => {
    const probe = usageProbe();
    let page = 0;
    const adapter = claudeAdapter(() => {
      page += 1;
      return jsonResponse(
        { data: [{ id: `m${String(page)}` }], has_more: page < 2, last_id: `m${String(page)}` },
        200,
        claudeHeaders(),
      );
    });
    await adapter.listModels(probe.ctx);
    expect(page).toBe(2);
    expect(probe.seen).toHaveLength(2);
  });

  it("delivers the stream's observation before its first event", async () => {
    const order: string[] = [];
    const adapter = claudeAdapter(() => sseResponse(ANT_STREAM, { headers: claudeHeaders() }));
    for await (const ev of adapter.chatStream(request, {
      onPlanUsage: () => order.push('usage'),
    })) {
      order.push(ev.type);
    }
    expect(order[0]).toBe('usage');
    expect(order.length).toBeGreaterThan(1);
  });

  it("a 429's thrown kind and message are identical with and without the dialect", async () => {
    const respond = (): HttpResponse =>
      errorResponse(429, '{"error":{"type":"rate_limit_error","message":"slow"}}', {
        ...claudeHeaders(),
        'retry-after': '30',
      });
    const withDialect = await claudeAdapter(respond)
      .chat(request, usageProbe().ctx)
      .catch((e: unknown) => e);
    const without = await claudeAdapter(respond, {})
      .chat(request, usageProbe().ctx)
      .catch((e: unknown) => e);
    expect(withDialect).toMatchObject({ kind: 'rate_limit' });
    expect(String((withDialect as Error).message)).toBe(String((without as Error).message));
    expect((withDialect as { kind: string }).kind).toBe((without as { kind: string }).kind);
  });

  it('clients never see quota headers: neither the buffered result nor any stream event carries a header', async () => {
    const headers = {
      ...claudeHeaders(),
      'x-codex-primary-used-percent': '12',
      'x-codex-primary-reset-at': String(nowSec() + 3600),
    };
    const hasHeaderTrace = (value: unknown): boolean =>
      /ratelimit|x-codex|used-percent|unified/i.test(JSON.stringify(value));
    const chat = await claudeAdapter(() => jsonResponse(ANT_CHAT, 200, headers)).chat(
      request,
      usageProbe().ctx,
    );
    expect(chat).not.toHaveProperty('headers');
    expect(hasHeaderTrace(chat)).toBe(false);
    const events = await drain(
      claudeAdapter(() => sseResponse(ANT_STREAM, { headers })).chatStream(
        request,
        usageProbe().ctx,
      ),
    );
    expect(events.length).toBeGreaterThan(0);
    expect(hasHeaderTrace(events)).toBe(false);
    for (const e of events) expect(e).not.toHaveProperty('headers');
  });

  it('reads no usage header when there is no dialect, or no callback', async () => {
    const reads: string[] = [];
    const spied = (): HttpResponse => {
      const res = jsonResponse(ANT_CHAT, 200, claudeHeaders());
      return {
        ...res,
        headers: {
          get: (n: string) => {
            reads.push(n.toLowerCase());
            return res.headers.get(n);
          },
          forEach: (cb: (v: string, n: string) => void) => {
            reads.push('<forEach>');
            res.headers.forEach?.(cb);
          },
        },
      };
    };
    const isUsageRead = (n: string): boolean =>
      n.startsWith('anthropic-ratelimit-') || n.startsWith('x-codex-') || n === '<forEach>';

    // no dialect, callback present
    const probe = usageProbe();
    await claudeAdapter(spied, {}).chat(request, probe.ctx);
    // dialect present, no callback
    await claudeAdapter(spied).chat(request);
    await drain(claudeAdapter(spied).chatStream(request));
    expect(probe.seen).toEqual([]);
    expect(reads.filter(isUsageRead)).toEqual([]);
  });

  it('a throwing callback leaves the result, the events and the error unchanged', async () => {
    const boom: CallContext = {
      onPlanUsage: () => {
        throw new Error('callback exploded');
      },
    };
    const ok = await claudeAdapter(() => jsonResponse(ANT_CHAT, 200, claudeHeaders())).chat(
      request,
      boom,
    );
    const baseline = await claudeAdapter(
      () => jsonResponse(ANT_CHAT, 200, claudeHeaders()),
      {},
    ).chat(request);
    expect(ok).toEqual(baseline);

    const evs = await drain(
      claudeAdapter(() => sseResponse(ANT_STREAM, { headers: claudeHeaders() })).chatStream(
        request,
        boom,
      ),
    );
    const evsBase = await drain(
      claudeAdapter(() => sseResponse(ANT_STREAM, { headers: claudeHeaders() }), {}).chatStream(
        request,
      ),
    );
    expect(evs).toEqual(evsBase);

    const respond = (): HttpResponse =>
      errorResponse(429, '{"error":{"type":"rate_limit_error","message":"slow"}}', claudeHeaders());
    const e1 = await claudeAdapter(respond)
      .chat(request, boom)
      .catch((e: unknown) => e);
    const e2 = await claudeAdapter(respond, {})
      .chat(request)
      .catch((e: unknown) => e);
    expect(e1).toMatchObject({ kind: (e2 as { kind: string }).kind });
    expect((e1 as Error).message).toBe((e2 as Error).message);
  });

  it('a throwing parser (a hostile header object) cannot touch the call', async () => {
    const hostile = (): HttpResponse => {
      const res = jsonResponse(ANT_CHAT, 200, claudeHeaders());
      return {
        ...res,
        headers: {
          get: () => {
            throw new Error('header read exploded');
          },
        },
      };
    };
    const probe = usageProbe();
    const out = await claudeAdapter(hostile).chat(request, probe.ctx);
    expect(out.content).toEqual([{ type: 'text', text: 'x' }]);
    expect(probe.seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// OpenCode Go (task 3.2): readers beside translation
// ---------------------------------------------------------------------------------------------

const oaiChunk = (extra: Record<string, unknown> = {}): unknown => ({
  id: 's',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }],
  ...extra,
});
const finalFrame = (opencode: unknown): unknown => ({
  id: 's',
  object: 'chat.completion.chunk',
  choices: [],
  usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7, opencode },
});
const goStream = (opencode: unknown): string =>
  oaiSse([
    oaiChunk(),
    { ...(oaiChunk() as object), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    finalFrame(opencode),
  ]);

describe('OpenCode Go readers (design D4)', () => {
  const go = (
    responder: Parameters<typeof recordingClient>[0],
    dialect = true,
  ): ProviderAdapter => {
    const { client } = recordingClient(responder);
    return createOpenaiProviderAdapter(oaiConfig(dialect ? { usageDialect: 'opencode_go' } : {}), {
      httpClient: client,
    });
  };

  it('a buffered response reports the billing source from the parsed body', async () => {
    const probe = usageProbe();
    const body = {
      ...OAI_CHAT,
      usage: { prompt_tokens: 1, opencode: { billing_source: 'balance' } },
    };
    const out = await go(() => jsonResponse(body)).chat(request, probe.ctx);
    expect(probe.seen).toEqual([{ windows: [], billing: 'extra_usage' }]);
    expect(out).toEqual(await go(() => jsonResponse(body), false).chat(request));
  });

  it('a stream reports its final usage frame once, and normalized events are deep-equal with and without the dialect', async () => {
    const probe = usageProbe();
    const sse = goStream({ billing_source: 'balance', allowance: 0.01 });
    const tapped = await drain(go(() => sseResponse(sse)).chatStream(request, probe.ctx));
    const plain = await drain(go(() => sseResponse(sse), false).chatStream(request));
    expect(tapped).toEqual(plain);
    expect(tapped.length).toBeGreaterThan(0);
    expect(probe.seen).toEqual([{ windows: [], billing: 'extra_usage' }]);
  });

  it('a usage frame split across tiny chunks is still read once complete', async () => {
    const probe = usageProbe();
    const sse = goStream({ billing_source: 'go' });
    const tapped = await drain(
      go(() => sseResponse(sse, { chunkSize: 7 })).chatStream(request, probe.ctx),
    );
    const plain = await drain(
      go(() => sseResponse(sse, { chunkSize: 7 }), false).chatStream(request),
    );
    expect(tapped).toEqual(plain);
    expect(probe.seen).toEqual([{ windows: [], billing: 'plan' }]);
  });

  it('an unknown billing source reports nothing', async () => {
    const probe = usageProbe();
    await drain(
      go(() => sseResponse(goStream({ billing_source: 'free' }))).chatStream(request, probe.ctx),
    );
    expect(probe.seen).toEqual([]);
  });

  it('an over-long line ends the tap without an observation or an error', async () => {
    const probe = usageProbe();
    const junk = `data: ${'x'.repeat(70 * 1024)}\n\n`;
    const sse = junk + goStream({ billing_source: 'balance' });
    // The junk line is not JSON; translate sees it exactly as it would without the tap.
    const tapped = await drain(go(() => sseResponse(sse)).chatStream(request, probe.ctx)).catch(
      (e: unknown) => e,
    );
    const plain = await drain(go(() => sseResponse(sse), false).chatStream(request)).catch(
      (e: unknown) => e,
    );
    expect(tapped).toEqual(plain);
    expect(probe.seen).toEqual([]);
  });

  it('reads nothing for opencode_go without a callback', async () => {
    const out = await go(() =>
      jsonResponse({ ...OAI_CHAT, usage: { opencode: { billing_source: 'balance' } } }),
    ).chat(request);
    expect(out.content).toEqual([{ type: 'text', text: 'x' }]);
  });
});

// ---------------------------------------------------------------------------------------------
// The Responses adapter's buffered facade (task 3.2)
// ---------------------------------------------------------------------------------------------

describe('Responses adapter buffered facade forwards onPlanUsage', () => {
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

  it('a codex observation arrives from a buffered chat folded from the stream', async () => {
    const { client } = recordingClient(() =>
      sseResponse(RESP_STREAM, {
        headers: {
          'x-codex-primary-used-percent': '12.5',
          'x-codex-primary-window-minutes': '300',
          'x-codex-primary-reset-at': String(nowSec() + 3600),
          'x-codex-secondary-used-percent': '40',
          'x-codex-secondary-window-minutes': '10080',
          'x-codex-secondary-reset-at': String(nowSec() + 86_400),
        },
      }),
    );
    const adapter = createResponsesProviderAdapter(
      {
        protocol: 'openai_responses',
        baseUrl: 'https://chatgpt.example/backend-api/codex',
        credential: 'tok',
        kind: 'subscription',
        mode: 'cloud',
        authScheme: 'oauth_bearer',
        oauthAccountId: 'acct',
        usageDialect: 'codex',
      },
      { httpClient: client },
    );
    const probe = usageProbe();
    await adapter.chat(request, probe.ctx);
    expect(probe.seen).toHaveLength(1);
    expect(probe.seen[0]!.windows.map((w) => [w.span, w.usedPercent])).toEqual([
      ['5h', 13],
      ['weekly', 40],
    ]);
    expect(probe.seen[0]!.billing).toBe('plan');
  });
});
