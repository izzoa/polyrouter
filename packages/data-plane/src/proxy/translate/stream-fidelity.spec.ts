// E2 stream-fidelity: conformant Anthropic message_delta (E2.1), stream_options
// opt-in (E2.2), truncation→error on both parsers (E2.7), unknown block/part/
// delta degradation + in-band error frame (E2.8).
import { openaiAdapter } from './openai';
import { anthropicAdapter } from './anthropic';
import { fromChunks, collect } from './stream';
import type { NormalizedStreamEvent } from './ir';
import type { OaiRequest } from './wire/openai';

const oai = openaiAdapter;
const ant = anthropicAdapter;

// eslint-disable-next-line @typescript-eslint/require-await -- sync source as an async iterable
async function* fromArray<T>(arr: readonly T[]): AsyncGenerator<T> {
  for (const x of arr) yield x;
}

const oaiSseNoDone = (chunks: readonly unknown[]): string =>
  chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');
const oaiSse = (chunks: readonly unknown[]): string => oaiSseNoDone(chunks) + 'data: [DONE]\n\n';
const antSse = (events: readonly { event: string; data: unknown }[]): string =>
  events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');

const textOf = (events: readonly NormalizedStreamEvent[]): string =>
  events
    .filter((e): e is Extract<NormalizedStreamEvent, { type: 'text_delta' }> => e.type === 'text_delta')
    .map((e) => e.text)
    .join('');

/** Parse serialized Anthropic SSE frames into `{ event, data }` objects. */
function parseAntFrames(sse: string): { event: string; data: Record<string, unknown> }[] {
  return sse
    .split('\n\n')
    .filter((b) => b.includes('event:'))
    .map((b) => {
      const event = /event: (.+)/.exec(b)?.[1] ?? '';
      const data = JSON.parse(/data: (.+)/.exec(b)?.[1] ?? '{}') as Record<string, unknown>;
      return { event, data };
    });
}

const OAI_STREAM = [
  { id: 'x', model: 'gpt', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
  { id: 'x', model: 'gpt', choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] },
  { id: 'x', model: 'gpt', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { id: 'x', model: 'gpt', choices: [], usage: { prompt_tokens: 3, completion_tokens: 7 } },
];

describe('E2.1 — conformant Anthropic message_delta when serializing an OpenAI upstream', () => {
  it('emits exactly one message_delta with numeric usage and a non-null stop_reason', async () => {
    const frames = parseAntFrames(
      (await collect(ant.streamSerialize(oai.streamParse(fromChunks([oaiSse(OAI_STREAM)]))))).join(''),
    );
    const deltas = frames.filter((f) => f.event === 'message_delta');
    expect(deltas).toHaveLength(1); // not one per IR event, no null-clobber
    const delta = deltas[0]!.data.delta as { stop_reason: unknown };
    expect(delta.stop_reason).toBe('end_turn'); // mapped from OpenAI 'stop', not null
    const usage = deltas[0]!.data.usage as { output_tokens: unknown };
    expect(typeof usage.output_tokens).toBe('number');
    expect(usage.output_tokens).toBe(7);
    // message_delta precedes message_stop, and is the ONLY message_delta.
    expect(frames.map((f) => f.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
  });
});

describe('E2.2 — streamed OpenAI requests opt into usage', () => {
  it('sets stream_options.include_usage only when streaming', () => {
    const ir = oai.requestIn({ model: 'gpt', messages: [{ role: 'user', content: 'hi' }], stream: true });
    expect((oai.requestOut(ir) as OaiRequest).stream_options).toEqual({ include_usage: true });
    const irNo = oai.requestIn({ model: 'gpt', messages: [{ role: 'user', content: 'hi' }] });
    expect((oai.requestOut(irNo) as OaiRequest).stream_options).toBeUndefined();
  });
});

describe('E2.7 — truncation is an error, not a clean stop', () => {
  it('OpenAI: exhaustion without [DONE]/finish yields error, no message_stop', async () => {
    const truncated = oaiSseNoDone([OAI_STREAM[0], OAI_STREAM[1]]); // no finish, no [DONE]
    const events = await collect(oai.streamParse(fromChunks([truncated])));
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.some((e) => e.type === 'message_stop')).toBe(false);
  });

  it('OpenAI: a normal terminated stream still ends with message_stop', async () => {
    const events = await collect(oai.streamParse(fromChunks([oaiSse(OAI_STREAM)])));
    expect(events.some((e) => e.type === 'message_stop')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('Anthropic: exhaustion without message_stop yields error', async () => {
    const truncated = antSse([
      { event: 'message_start', data: { type: 'message_start', message: { id: 'm', model: 'c', usage: {} } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } } },
    ]); // no message_stop
    const events = await collect(ant.streamParse(fromChunks([truncated])));
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});

describe('E2.8 — unknown blocks/parts/deltas degrade, never crash', () => {
  it('Anthropic stream: a thinking block is skipped, text streams, no malformed tool_use_delta', async () => {
    const withThinking = antSse([
      { event: 'message_start', data: { type: 'message_start', message: { id: 'm', model: 'c', usage: {} } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const events = await collect(ant.streamParse(fromChunks([withThinking])));
    expect(textOf(events)).toBe('Hi');
    expect(
      events.some((e) => e.type === 'tool_use_delta' && e.partialJson === undefined),
    ).toBe(false);
    expect(events.some((e) => e.type === 'message_stop')).toBe(true);
    // The surviving text block is re-indexed DENSELY (0), not left at its upstream
    // index (1) — else the Anthropic SDK appends it at 0 but routes its delta to 1
    // and drops the text (review finding 1). Assert both the IR and the re-serialized wire.
    const textStart = events.find((e) => e.type === 'text_delta');
    expect(textStart?.type === 'text_delta' ? textStart.index : -1).toBe(0);
    const frames = parseAntFrames((await collect(ant.streamSerialize(fromArray(events)))).join(''));
    const cbStart = frames.find((f) => f.event === 'content_block_start');
    expect(cbStart?.data.index).toBe(0);
  });

  it('Anthropic: a message_stop with no stop_reason ever seen is an IR error, not a clean stop', async () => {
    const incomplete = antSse([
      { event: 'message_start', data: { type: 'message_start', message: { id: 'm', model: 'c', usage: {} } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'message_stop', data: { type: 'message_stop' } }, // no message_delta with a stop_reason
    ]);
    const events = await collect(ant.streamParse(fromChunks([incomplete])));
    expect(events.some((e) => e.type === 'error')).toBe(true); // core sees this → status=error
    expect(events.some((e) => e.type === 'message_stop')).toBe(false);
  });

  it('OpenAI: [DONE] with no finish_reason is an IR error, not a clean stop', async () => {
    // A frame with content but no finish_reason, then [DONE].
    const sse = oaiSse([OAI_STREAM[0], OAI_STREAM[1]]); // oaiSse appends [DONE]; no finish chunk
    const events = await collect(oai.streamParse(fromChunks([sse])));
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.some((e) => e.type === 'message_stop')).toBe(false);
  });

  it('Anthropic response: an unknown block is skipped and serialization does not throw', () => {
    const ir = ant.responseIn(
      {
        id: 'm',
        model: 'c',
        content: [
          { type: 'thinking', thinking: 'reasoning' },
          { type: 'text', text: 'answer' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    );
    expect(ir.content).toEqual([{ type: 'text', text: 'answer' }]);
    expect(() => ant.responseOut(ir)).not.toThrow();
    expect(() => oai.responseOut(ir)).not.toThrow();
  });

  it('OpenAI request: an unknown content part is skipped, not force-read as an image', () => {
    const ir = oai.requestIn({
      model: 'gpt',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_audio', input_audio: { data: 'x', format: 'wav' } },
            { type: 'text', text: 'transcribe' },
          ],
        },
      ],
    });
    expect(ir.messages[0]!.content).toEqual([{ type: 'text', text: 'transcribe' }]);
  });

  it('Anthropic stream: a malformed tool_use finalizes as inputParseError, never throws', async () => {
    const sse = antSse([
      { event: 'message_start', data: { type: 'message_start', message: { id: 'm', model: 'c', usage: {} } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'get_weather' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{ "loc' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } }, // never valid JSON
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    const events = await collect(ant.streamParse(fromChunks([sse])));
    const stop = events.find((e) => e.type === 'block_stop');
    const finalized = stop?.type === 'block_stop' ? stop.finalizedToolUse : undefined;
    expect(finalized && 'inputParseError' in finalized ? finalized.inputParseError : false).toBe(true);
  });

  it('OpenAI stream: an in-band error frame becomes a normalized error event (no TypeError)', async () => {
    const sse = `data: ${JSON.stringify({ error: { type: 'server_error', message: 'boom' } })}\n\ndata: [DONE]\n\n`;
    const events = await collect(oai.streamParse(fromChunks([sse])));
    const err = events.find((e) => e.type === 'error');
    expect(err?.type === 'error' ? err.error.type : null).toBe('server_error');
  });
});
