import { evaluateQuality, responseToStreamEvents } from './cascade';
import { replayBufferedStream } from './core';
import { getAdapter } from './translate';
import type { NormalizedResponse, NormalizedStopReason, ProtocolAdapter } from './translate';

function resp(p: Partial<NormalizedResponse>): NormalizedResponse {
  return {
    id: 'r1',
    model: 'm',
    content: [{ type: 'text', text: 'hello world' }],
    stopReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 5 },
    ...p,
  };
}
const stop = (s: NormalizedStopReason): Partial<NormalizedResponse> => ({ stopReason: s });

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

describe('evaluateQuality — the graded lattice (harden-cascade-quality-gate)', () => {
  const demand = { structuredDemand: true };
  const textResp = (text: string, stopReason: NormalizedStopReason = 'stop') =>
    resp({ content: [{ type: 'text', text }], stopReason });

  it('length truncation scores 0.5 with no hard failure — ctx-independent', () => {
    expect(evaluateQuality(resp(stop('length')))).toBe(0.5);
    expect(evaluateQuality(resp(stop('length')), {})).toBe(0.5);
    expect(evaluateQuality(resp(stop('length')), { structuredDemand: false })).toBe(0.5);
  });

  it('demanded JSON: prose fails, valid JSON passes (whitespace-wrapped too)', () => {
    expect(evaluateQuality(textResp('Hello from stub'), demand)).toBe(0);
    expect(evaluateQuality(textResp('{"a":1}'), demand)).toBe(1);
    expect(evaluateQuality(textResp('  {"a": 1}\n '), demand)).toBe(1);
    expect(evaluateQuality(textResp('answer: {"a":1}'), demand)).toBe(0); // prose-prefixed
    expect(evaluateQuality(textResp('```json\n{"a":1}\n```'), demand)).toBe(0); // fenced is non-conformant
  });

  it('without the demand flag the same prose passes (conformance is ctx-gated)', () => {
    expect(evaluateQuality(textResp('Hello from stub'))).toBe(1);
    expect(evaluateQuality(textResp('Hello from stub'), { structuredDemand: false })).toBe(1);
  });

  it('multi-block: ONE document split across blocks conforms; adjacent documents do not', () => {
    const split = resp({
      content: [
        { type: 'text', text: '{"a":' },
        { type: 'text', text: '1}' },
      ],
    });
    expect(evaluateQuality(split, demand)).toBe(1);
    const adjacent = resp({
      content: [
        { type: 'text', text: '{"a":1}' },
        { type: 'text', text: '{"b":2}' },
      ],
    });
    expect(evaluateQuality(adjacent, demand)).toBe(0);
  });

  it('ZERO-PRECEDENCE: demanded JSON cut off by the cap is 0 (escalates at default); valid-but-truncated is 0.5', () => {
    expect(evaluateQuality(textResp('{"a": [1, 2', 'length'), demand)).toBe(0);
    expect(evaluateQuality(textResp('{"a": 1}', 'length'), demand)).toBe(0.5);
  });

  it('tool-TURN exemption: a tool_use block, a pause stop, or a tool_use stop — all with nonempty prose — score 1 under demand', () => {
    // A NORMAL stop with a tool block present — proves the block-presence
    // exemption independently of the stop-reason exemption (r3-Low-2).
    const withBlock = resp({
      content: [
        { type: 'text', text: 'calling a tool' },
        { type: 'tool_use', id: 't1', name: 'f', input: {} },
      ],
      stopReason: 'stop',
    });
    expect(evaluateQuality(withBlock, demand)).toBe(1);
    expect(evaluateQuality(textResp('pausing for the server tool', 'pause'), demand)).toBe(1);
    expect(evaluateQuality(textResp('continuing shortly', 'tool_use'), demand)).toBe(1); // no modeled block
  });

  it('exemption never masks hard failures (empty / malformed args still 0)', () => {
    expect(evaluateQuality(resp({ content: [], stopReason: 'pause' }), demand)).toBe(0);
    expect(
      evaluateQuality(
        resp({
          content: [
            { type: 'tool_use', id: 't1', name: 'f', inputRaw: '{bad', inputParseError: true },
          ],
          stopReason: 'tool_use',
        }),
        demand,
      ),
    ).toBe(0);
  });

  it('language neutrality: same structure, two languages, same score', () => {
    expect(evaluateQuality(textResp('plain prose answer'), demand)).toBe(
      evaluateQuality(textResp('プレーンな散文の答え'), demand),
    );
  });
});

describe('evaluateQuality (binary, language-neutral)', () => {
  it('scores usable answers 1.0', () => {
    expect(evaluateQuality(resp({}))).toBe(1); // text
    expect(
      evaluateQuality(resp({ content: [{ type: 'tool_use', id: 't', name: 'f', input: {} }] })),
    ).toBe(1); // tool-only
    // `length` moved to the 0.5 uncertainty grade (harden-cascade-quality-gate)
    // — asserted in its own suite below; tool_use/pause stops stay 1 here.
    expect(
      evaluateQuality(
        resp({
          content: [{ type: 'tool_use', id: 't', name: 'f', input: {} }],
          stopReason: 'pause',
        }),
      ),
    ).toBe(1); // agentic pause is a correct response
  });

  it('scores unusable answers 0', () => {
    expect(evaluateQuality(resp({ content: [] }))).toBe(0); // empty
    expect(evaluateQuality(resp({ content: [{ type: 'text', text: '   ' }] }))).toBe(0); // whitespace only
    expect(evaluateQuality(resp(stop('error')))).toBe(0);
    expect(evaluateQuality(resp(stop('content_filter')))).toBe(0);
    expect(
      evaluateQuality(
        resp({
          content: [
            { type: 'tool_use', id: 't', name: 'f', inputRaw: '{bad', inputParseError: true },
          ],
          stopReason: 'tool_use',
        }),
      ),
    ).toBe(0); // malformed tool args
  });
});

describe('responseToStreamEvents → client.streamSerialize', () => {
  const openai = getAdapter('openai');
  const anthropic = getAdapter('anthropic');

  async function frames(client: ProtocolAdapter, r: NormalizedResponse): Promise<string> {
    const events = responseToStreamEvents(r);
    // eslint-disable-next-line @typescript-eslint/require-await -- AsyncIterable feed for streamSerialize
    const gen = (async function* () {
      for (const e of events) yield e;
    })();
    return (await collect(client.streamSerialize(gen, { created: 0 }))).join('');
  }

  it('round-trips a text response for both protocols with a correct terminator', async () => {
    const r = resp({ content: [{ type: 'text', text: 'the answer is 42' }] });
    const oai = await frames(openai, r);
    expect(oai).toContain('the answer is 42');
    expect(oai).toContain('[DONE]');
    const ant = await frames(anthropic, r);
    expect(ant).toContain('the answer is 42');
    expect(ant).toContain('event: message_stop');
    // block_stop for the text block → balanced content_block start/stop (the #3 fix).
    expect(count(ant, 'event: content_block_start')).toBe(count(ant, 'event: content_block_stop'));
    expect(count(ant, 'event: content_block_start')).toBe(1);
  });

  it('round-trips a parsed tool call (JSON.stringify args), balanced blocks', async () => {
    const r = resp({
      content: [{ type: 'tool_use', id: 't1', name: 'get_weather', input: { city: 'NYC' } }],
      stopReason: 'tool_use',
    });
    const oai = await frames(openai, r);
    expect(oai).toContain('get_weather');
    expect(oai).toContain('NYC');
    const ant = await frames(anthropic, r);
    expect(ant).toContain('get_weather');
    expect(count(ant, 'event: content_block_start')).toBe(count(ant, 'event: content_block_stop'));
  });

  it('round-trips malformed tool args verbatim (inputRaw)', async () => {
    const r = resp({
      content: [
        { type: 'tool_use', id: 't1', name: 'f', inputRaw: '{not json', inputParseError: true },
      ],
      stopReason: 'tool_use',
    });
    expect(await frames(openai, r)).toContain('{not json');
  });

  it('keeps balanced blocks for parallel tool calls', async () => {
    const r = resp({
      content: [
        { type: 'tool_use', id: 't1', name: 'a', input: {} },
        { type: 'tool_use', id: 't2', name: 'b', input: {} },
      ],
      stopReason: 'tool_use',
    });
    const ant = await frames(anthropic, r);
    expect(count(ant, 'event: content_block_start')).toBe(2);
    expect(count(ant, 'event: content_block_stop')).toBe(2);
  });
});

describe('replayBufferedStream', () => {
  const openai = getAdapter('openai');

  it('replays a buffered response with usage from the response and a success outcome', async () => {
    const r = resp({
      content: [{ type: 'text', text: 'hi there' }],
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    const result = await replayBufferedStream(openai, r, { created: 0 });
    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') return;
    const body = (await collect(result.frames)).join('');
    expect(body).toContain('hi there');
    expect(body).toContain('[DONE]');
    const outcome = await result.outcome;
    expect(outcome.status).toBe('success');
    expect(outcome.usage.inputTokens).toBe(7); // from the buffered response, not delivery progress
    expect(outcome.usage.outputTokens).toBe(3);
  });

  it('returns { kind: "failed" } when serialization throws (caller escalates)', async () => {
    const broken = {
      streamSerialize: (): AsyncGenerator<string> => {
        throw new Error('serialize boom'); // synchronous throw → caught before any byte
      },
    } as unknown as ProtocolAdapter;
    const result = await replayBufferedStream(broken, resp({}), { created: 0 });
    expect(result.kind).toBe('failed');
  });
});
