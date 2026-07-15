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

describe('evaluateQuality (binary, language-neutral)', () => {
  it('scores usable answers 1.0', () => {
    expect(evaluateQuality(resp({}))).toBe(1); // text
    expect(
      evaluateQuality(resp({ content: [{ type: 'tool_use', id: 't', name: 'f', input: {} }] })),
    ).toBe(1); // tool-only
    expect(evaluateQuality(resp(stop('length')))).toBe(1); // truncated but valid
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
