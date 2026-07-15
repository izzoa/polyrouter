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
    const frames = await collect(oai.streamSerialize(fromArray(events)));
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
    const frames = await collect(oai.streamSerialize(fromArray(events)));
    const reparsed = await collect(oai.streamParse(fromChunks([frames.join('')])));
    expect(concatText(reparsed)).toBe('Hello world');
    // Crossing to OpenAI folds cache-write into prompt_tokens: reparsed input = 100+10.
    expect(mergedUsage(reparsed)).toEqual({
      inputTokens: 110,
      outputTokens: 2,
      cacheReadTokens: 80,
    });
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
