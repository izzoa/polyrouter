import { openaiAdapter } from './openai';
import { anthropicAdapter } from './anthropic';
import { fromChunks, collect } from './stream';
import { mergePartialUsage, partialToNormalized } from './usage';
import type { NormalizedStreamEvent, NormalizedUsage, ToolUseBlock } from './ir';
import oaiStreamed from './golden/openai/streamed.json';
import antStreamed from './golden/anthropic/streamed.json';

const oai = openaiAdapter;
const ant = anthropicAdapter;

function oaiSse(chunks: readonly unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}
function antSse(events: readonly { event: string; data: unknown }[]): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
}
// eslint-disable-next-line @typescript-eslint/require-await -- a synchronous source presented as an async iterable
async function* fromArray<T>(arr: readonly T[]): AsyncGenerator<T> {
  for (const x of arr) yield x;
}
function concatText(events: readonly NormalizedStreamEvent[]): string {
  return events
    .filter(
      (e): e is Extract<NormalizedStreamEvent, { type: 'text_delta' }> => e.type === 'text_delta',
    )
    .map((e) => e.text)
    .join('');
}
function mergedUsage(events: readonly NormalizedStreamEvent[]): NormalizedUsage | undefined {
  const parts = events
    .filter(
      (e): e is Extract<NormalizedStreamEvent, { type: 'message_start' | 'message_delta' }> =>
        e.type === 'message_start' || e.type === 'message_delta',
    )
    .map((e) => e.usage);
  return partialToNormalized(mergePartialUsage(...parts));
}

describe('streaming — OpenAI parse/serialize round-trip', () => {
  it('concatenates text and surfaces terminal usage from the empty-choices chunk', async () => {
    const events = await collect(oai.streamParse(fromChunks([oaiSse(oaiStreamed.textChunks)])));
    expect(concatText(events)).toBe('Hello world');
    const stop = events.find((e) => e.type === 'message_delta' && e.stopReason !== undefined);
    expect(stop?.type === 'message_delta' ? stop.stopReason : null).toBe('stop');
    expect(mergedUsage(events)).toEqual({ inputTokens: 20, outputTokens: 2, cacheReadTokens: 80 });
    // no spurious text_delta from the terminal empty-choices usage chunk
    expect(events.filter((e) => e.type === 'text_delta')).toHaveLength(2);
  });

  it('re-serializes to OpenAI chunks that re-parse to the same text and usage', async () => {
    const events = await collect(oai.streamParse(fromChunks([oaiSse(oaiStreamed.textChunks)])));
    // includeUsage: the client opted into the terminal usage chunk (A-7).
    const frames = await collect(oai.streamSerialize(fromArray(events), { includeUsage: true }));
    const joined = frames.join('');
    expect(joined).toContain('data: [DONE]');
    const reparsed = await collect(oai.streamParse(fromChunks([joined])));
    expect(concatText(reparsed)).toBe('Hello world');
    expect(mergedUsage(reparsed)).toEqual({
      inputTokens: 20,
      outputTokens: 2,
      cacheReadTokens: 80,
    });
  });
});

describe('streaming — tool-call JSON assembly', () => {
  it('assembles per-block JSON and finalizes at block_stop', async () => {
    const events = await collect(oai.streamParse(fromChunks([oaiSse(oaiStreamed.toolChunks)])));
    const stop = events.find(
      (e): e is Extract<NormalizedStreamEvent, { type: 'block_stop' }> => e.type === 'block_stop',
    );
    const finalized = stop?.finalizedToolUse as ToolUseBlock | undefined;
    expect(finalized && 'input' in finalized ? finalized.input : null).toEqual({ city: 'SF' });
    expect(finalized?.name).toBe('get_weather');
  });

  it('emits tool_use_start exactly once per block even if id/name repeat on later fragments (A-6)', async () => {
    // A provider that repeats id/name on subsequent argument fragments must not
    // re-open the block; and two DISTINCT tool indices each get their own start.
    const frag = (
      index: number,
      args: string,
      id?: string,
      name?: string,
    ): Record<string, unknown> => {
      const fn: Record<string, unknown> = { arguments: args };
      if (name !== undefined) fn['name'] = name;
      const tc: Record<string, unknown> = { index, function: fn };
      if (id !== undefined) tc['id'] = id;
      return { choices: [{ index: 0, delta: { tool_calls: [tc] } }] };
    };
    const chunks = [
      { id: 'c', model: 'm', choices: [{ index: 0, delta: { role: 'assistant' } }] },
      frag(0, '{"a":', 't1', 'f'),
      frag(0, '1}', 't1', 'f'), // repeats id+name — must NOT re-open block 0
      frag(1, '{}', 't2', 'g'), // distinct parallel index → its own start
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ];
    const events = await collect(oai.streamParse(fromChunks([oaiSse(chunks)])));
    const starts = events.filter((e) => e.type === 'tool_use_start');
    expect(starts).toHaveLength(2); // one per distinct block, never a duplicate for t1
    expect(starts.map((s) => (s as { id: string }).id).sort()).toEqual(['t1', 't2']);
  });

  it('finalizes malformed tool JSON as an inputParseError block, never throwing', async () => {
    const badChunks = [
      {
        id: 'c',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      },
      {
        id: 'c',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_x',
                  type: 'function',
                  function: { name: 'f', arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'c',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'c',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      },
    ];
    const events = await collect(oai.streamParse(fromChunks([oaiSse(badChunks)])));
    const stop = events.find(
      (e): e is Extract<NormalizedStreamEvent, { type: 'block_stop' }> => e.type === 'block_stop',
    );
    const finalized = stop?.finalizedToolUse as ToolUseBlock | undefined;
    expect(finalized && 'inputParseError' in finalized ? finalized.inputParseError : null).toBe(
      true,
    );
    expect(finalized && 'inputRaw' in finalized ? finalized.inputRaw : null).toBe('{"city":');
  });
});

describe('streaming — split SSE frames', () => {
  it('tolerates frames split at arbitrary byte offsets', async () => {
    const full = oaiSse(oaiStreamed.textChunks);
    const pieces: string[] = [];
    for (let i = 0; i < full.length; i += 7) pieces.push(full.slice(i, i + 7));
    const events = await collect(oai.streamParse(fromChunks(pieces)));
    expect(concatText(events)).toBe('Hello world');
    expect(mergedUsage(events)).toEqual({ inputTokens: 20, outputTokens: 2, cacheReadTokens: 80 });
  });
});

describe('streaming — Anthropic parse + usage lifecycle', () => {
  it('merges input/cache usage from message_start with output from message_delta', async () => {
    const events = await collect(ant.streamParse(fromChunks([antSse(antStreamed.textEvents)])));
    expect(concatText(events)).toBe('Hello world');
    expect(mergedUsage(events)).toEqual({
      inputTokens: 100,
      outputTokens: 2,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
    });
  });

  it('cross-serializes an Anthropic stream to OpenAI chunks with merged usage', async () => {
    const events = await collect(ant.streamParse(fromChunks([antSse(antStreamed.textEvents)])));
    const frames = await collect(oai.streamSerialize(fromArray(events), { includeUsage: true }));
    const reparsed = await collect(oai.streamParse(fromChunks([frames.join('')])));
    expect(concatText(reparsed)).toBe('Hello world');
    // Crossing to OpenAI folds cache-write into prompt_tokens: reparsed input = 100+10.
    expect(mergedUsage(reparsed)).toEqual({
      inputTokens: 110,
      outputTokens: 2,
      cacheReadTokens: 80,
    });
  });

  it('omits the terminal usage chunk when the client did NOT opt in (A-7)', async () => {
    const events = await collect(oai.streamParse(fromChunks([oaiSse(oaiStreamed.textChunks)])));
    // No `includeUsage` → the OpenAI serializer emits no trailing choices:[] usage
    // chunk (matching OpenAI, which only sends it on stream_options.include_usage).
    const frames = (await collect(oai.streamSerialize(fromArray(events)))).join('');
    expect(frames).toContain('data: [DONE]');
    const reparsed = await collect(oai.streamParse(fromChunks([frames])));
    expect(concatText(reparsed)).toBe('Hello world'); // text intact
    expect(mergedUsage(reparsed)).toBeUndefined(); // no usage chunk relayed
  });
});

describe('streaming — interrupted stream', () => {
  it('leaves usage undefined (never zero) when no terminal usage arrives', async () => {
    const truncated = oaiStreamed.textChunks.slice(0, 4); // drop the usage chunk
    const events = await collect(oai.streamParse(fromChunks([oaiSse(truncated)])));
    expect(concatText(events)).toBe('Hello world');
    expect(mergedUsage(events)).toBeUndefined();
  });
});
