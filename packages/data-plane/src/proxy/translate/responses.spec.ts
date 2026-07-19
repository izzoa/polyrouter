// add-chatgpt-responses — golden contract suite for the openai_responses upstream
// protocol. These goldens PIN the implemented wire shape (field names are
// verify-at-implementation against the live backend, task 6.2).
import { createResponsesAdapter } from './responses';
import { fromChunks } from './stream';
import type { NormalizedRequest, NormalizedStreamEvent } from './ir';

const adapter = createResponsesAdapter();

const sse = (events: object[]): string[] =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`);

async function collectEvents(chunks: string[]): Promise<NormalizedStreamEvent[]> {
  const out: NormalizedStreamEvent[] = [];
  for await (const ev of adapter.streamParse(fromChunks(chunks))) out.push(ev);
  return out;
}

describe('openai_responses — request out (golden)', () => {
  it('serializes system/tools with store:false always; caps and sampling are DROPPED (wire-rejected)', () => {
    const ir: NormalizedRequest = {
      model: 'gpt-5.4-mini',
      system: [{ type: 'text', text: 'be terse' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'get_time', description: 'time', parameters: { type: 'object' } }],
      toolChoice: 'auto',
      allowParallelTools: true,
      params: { maxOutputTokens: 128, temperature: 0.2, topP: 0.9 },
      stream: false,
    };
    // VERIFIED LIVE: the backend rejects max_output_tokens/temperature/top_p as
    // "Unsupported parameter" — they are documented drops, never serialized.
    expect(adapter.requestOut(ir)).toEqual({
      model: 'gpt-5.4-mini',
      instructions: 'be terse', // single-block system → instructions
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      tools: [{ type: 'function', name: 'get_time', description: 'time', parameters: { type: 'object' } }],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      store: false, // ALWAYS
      stream: false,
    });
  });

  it('multi-block system → developer-role items (boundaries preserved, instructions unset)', () => {
    const ir: NormalizedRequest = {
      model: 'm',
      system: [
        { type: 'text', text: 'block one' },
        { type: 'text', text: 'block two' },
        { type: 'text', text: 'block three' },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
      params: { maxOutputTokens: 16 },
    };
    const wire = adapter.requestOut(ir) as { instructions?: string; input: unknown[] };
    expect(wire.instructions).toBeUndefined();
    expect(wire.input.slice(0, 3)).toEqual([
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'block one' }] },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'block two' }] },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'block three' }] },
    ]);
  });

  it('never emits the wire-rejected params, with or without IR values', () => {
    const bare: NormalizedRequest = {
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
      params: {},
    };
    const withParams: NormalizedRequest = {
      ...bare,
      params: { maxOutputTokens: 512, temperature: 1, topP: 0.5 },
    };
    for (const ir of [bare, withParams]) {
      const wire = adapter.requestOut(ir) as Record<string, unknown>;
      expect('max_output_tokens' in wire).toBe(false);
      expect('temperature' in wire).toBe(false);
      expect('top_p' in wire).toBe(false);
    }
  });

  it('multi-turn tool round-trip correlates by call_id (never output-item id)', () => {
    const ir: NormalizedRequest = {
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'time?' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_abc', name: 'get_time', input: { tz: 'UTC' } }],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool_result', toolUseId: 'call_abc', content: [{ type: 'text', text: '12:00' }] },
          ],
        },
      ],
      params: { maxOutputTokens: 16 },
    };
    const wire = adapter.requestOut(ir) as { input: unknown[] };
    expect(wire.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'time?' }] },
      { type: 'function_call', call_id: 'call_abc', name: 'get_time', arguments: '{"tz":"UTC"}' },
      { type: 'function_call_output', call_id: 'call_abc', output: '12:00' },
    ]);
  });
});

describe('openai_responses — response in (golden)', () => {
  const base = { id: 'resp_1', model: 'gpt-5-codex', status: 'completed' };

  it('maps text + parallel tool calls + usage with cached subtraction', () => {
    const ir = adapter.responseIn({
      ...base,
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
        { type: 'function_call', call_id: 'c1', name: 'a', arguments: '{"x":1}' },
        { type: 'function_call', call_id: 'c2', name: 'b', arguments: '{"y":2}' },
      ],
      usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 40 } },
    });
    expect(ir.content).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: 'c1', name: 'a', input: { x: 1 } },
      { type: 'tool_use', id: 'c2', name: 'b', input: { y: 2 } },
    ]);
    expect(ir.stopReason).toBe('tool_use');
    expect(ir.usage).toEqual({ inputTokens: 60, outputTokens: 5, cacheReadTokens: 40 }); // uncached rule
  });

  it('maps stop reasons: incomplete(max_output_tokens) → length; content_filter; refusal as text', () => {
    const length = adapter.responseIn({
      ...base,
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }],
    });
    expect(length.stopReason).toBe('length');
    const filtered = adapter.responseIn({
      ...base,
      status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
      output: [],
    });
    expect(filtered.stopReason).toBe('content_filter');
    const refusal = adapter.responseIn({
      ...base,
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'cannot help' }] }],
    });
    expect(refusal.content).toEqual([{ type: 'text', text: 'cannot help' }]); // refusal AS text
  });

  it('missing usage stays undefined (usage_estimated path); malformed tool JSON represented', () => {
    const ir = adapter.responseIn({
      ...base,
      output: [{ type: 'function_call', call_id: 'c1', name: 'a', arguments: 'not json' }],
    });
    expect(ir.usage).toBeUndefined();
    expect(ir.content[0]).toEqual({
      type: 'tool_use',
      id: 'c1',
      name: 'a',
      inputRaw: 'not json',
      inputParseError: true,
    });
  });

  it('reasoning items are dropped, never represented', () => {
    const ir = adapter.responseIn({
      ...base,
      output: [
        { type: 'reasoning', encrypted_content: 'opaque-blob' },
        { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
      ],
    });
    expect(ir.content).toEqual([{ type: 'text', text: 'answer' }]);
  });

  it('a failed response surfaces typed with a FIXED message — hostile bodies never leak', () => {
    let thrown: Error | null = null;
    try {
      adapter.responseIn({
        ...base,
        status: 'failed',
        error: { message: 'token oat-SECRET for acct-LEAK rejected' },
        output: [],
      });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toBe('openai_responses: upstream reported failure');
    expect(thrown!.message).not.toContain('SECRET');
    expect(thrown!.message).not.toContain('acct-LEAK');
  });

  it('a multimodal tool result serializes as a content ARRAY (never text-flattened)', () => {
    const ir: NormalizedRequest = {
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_1', name: 'screenshot', input: {} }],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolUseId: 'call_1',
              content: [
                { type: 'text', text: 'the page:' },
                { type: 'image', mediaType: 'image/png', data: 'aWK=' },
              ],
            },
          ],
        },
      ],
      params: { maxOutputTokens: 16 },
    };
    const wire = adapter.requestOut(ir) as { input: Array<Record<string, unknown>> };
    const out = wire.input.find((i) => i['type'] === 'function_call_output')!;
    expect(out['output']).toEqual([
      { type: 'input_text', text: 'the page:' },
      { type: 'input_image', image_url: 'data:image/png;base64,aWK=' },
    ]);
    // Text-only results keep the plain-string form (the golden-stable common case).
    const textOnly: NormalizedRequest = {
      ...ir,
      messages: [
        ir.messages[0]!,
        {
          role: 'tool',
          content: [
            { type: 'tool_result', toolUseId: 'call_1', content: [{ type: 'text', text: 'ok' }] },
          ],
        },
      ],
    };
    const textWire = adapter.requestOut(textOnly) as { input: Array<Record<string, unknown>> };
    expect(textWire.input.find((i) => i['type'] === 'function_call_output')!['output']).toBe('ok');
  });
});

describe('openai_responses — streaming (golden)', () => {
  it('reassembles text + two parallel tool calls (composite output_index:item_id key, no .done duplication)', async () => {
    const events = await collectEvents(
      sse([
        { type: 'response.created', response: { id: 'r1', model: 'm' } },
        { type: 'response.output_text.delta', item_id: 'msg1', output_index: 0, delta: 'Hel' },
        { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'it1', call_id: 'c1', name: 'a' } },
        { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'it2', call_id: 'c2', name: 'b' } },
        { type: 'response.function_call_arguments.delta', item_id: 'it1', output_index: 1, delta: '{"x"' },
        { type: 'response.function_call_arguments.delta', item_id: 'it2', output_index: 2, delta: '{"y"' },
        { type: 'response.output_text.delta', item_id: 'msg1', output_index: 0, delta: 'lo' },
        { type: 'response.function_call_arguments.delta', item_id: 'it1', output_index: 1, delta: ':1}' },
        { type: 'response.function_call_arguments.delta', item_id: 'it2', output_index: 2, delta: ':2}' },
        { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'it1', call_id: 'c1', name: 'a', arguments: '{"x":1}' } },
        { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'it2', call_id: 'c2', name: 'b', arguments: '{"y":2}' } },
        { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 4 } } },
      ]),
    );
    // message_start is emitted LAZILY at the first real output, with the buffered
    // created metadata — never for the bare acknowledgment (commit rule).
    expect(events[0]).toEqual({ type: 'message_start', id: 'r1', model: 'm', role: 'assistant' });
    const text = events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe('Hello');
    const finalized = events.filter((e) => e.type === 'block_stop' && e.finalizedToolUse !== undefined);
    expect(finalized).toHaveLength(2); // exactly once each — no .done duplication
    expect((finalized[0] as { finalizedToolUse: { id: string; input?: unknown } }).finalizedToolUse).toMatchObject({ id: 'c1', input: { x: 1 } });
    const delta = events.find((e) => e.type === 'message_delta') as { stopReason?: string; usage?: unknown };
    expect(delta.stopReason).toBe('tool_use');
    expect(delta.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
    expect(events.at(-1)?.type).toBe('message_stop');
  });

  it('streamed refusal assembles as text exactly once (delta + done, no duplication)', async () => {
    const events = await collectEvents(
      sse([
        { type: 'response.created', response: { id: 'r1', model: 'm' } },
        { type: 'response.refusal.delta', item_id: 'msg1', delta: 'cannot ' },
        { type: 'response.refusal.delta', item_id: 'msg1', delta: 'help' },
        { type: 'response.refusal.done', item_id: 'msg1', refusal: 'cannot help' },
        { type: 'response.completed', response: {} },
      ]),
    );
    const text = events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe('cannot help'); // never dropped as unknown, never doubled
  });

  it('incomplete → length (message_start synthesized for a zero-output success terminal)', async () => {
    const incomplete = await collectEvents(
      sse([
        { type: 'response.created', response: {} },
        { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
      ]),
    );
    expect(incomplete.map((e) => e.type)).toEqual(['message_start', 'message_delta', 'message_stop']);
    expect((incomplete.find((e) => e.type === 'message_delta') as { stopReason?: string }).stopReason).toBe('length');
  });

  it('a pre-output failure is the FIRST event — no message_start, so the proxy can fall back', async () => {
    const failed = await collectEvents(
      sse([
        { type: 'response.created', response: {} },
        { type: 'response.failed', response: { error: { code: 'server_error', message: 'token oat-SECRET rejected' } } },
      ]),
    );
    // The acknowledgment alone never commits; the failure is event #1 and the
    // untrusted upstream message is REPLACED by the fixed one.
    expect(failed).toEqual([
      { type: 'error', error: { type: 'server_error', message: 'upstream stream error' } },
    ]);
    const inband = await collectEvents(
      sse([{ type: 'response.created', response: {} }, { type: 'error', code: 'overloaded', message: 'busy' }]),
    );
    expect(inband).toEqual([
      { type: 'error', error: { type: 'overloaded', message: 'upstream stream error' } },
    ]);
    // A hostile/free-text code is not forwarded as the classification type either.
    const hostile = await collectEvents(
      sse([{ type: 'response.created', response: {} }, { type: 'error', code: 'acct LEAK\r\nx', message: 'x' }]),
    );
    expect(hostile).toEqual([
      { type: 'error', error: { type: 'server_error', message: 'upstream stream error' } },
    ]);
  });

  it('EOF without a terminal yields a truncated ERROR, never a clean message_stop', async () => {
    const events = await collectEvents(
      sse([
        { type: 'response.created', response: {} },
        { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, delta: 'partial' },
      ]),
    );
    expect(events.some((e) => e.type === 'message_stop')).toBe(false);
    expect(events.at(-1)).toEqual({
      type: 'error',
      error: { type: 'truncated', message: 'upstream stream ended without a terminator' },
    });
  });

  it('unknown events and reasoning deltas are skipped without corrupting the stream', async () => {
    const events = await collectEvents(
      sse([
        { type: 'response.created', response: {} },
        { type: 'response.reasoning_summary_text.delta', item_id: 'r', delta: 'thinking…' },
        { type: 'response.some_future_event', payload: 1 },
        { type: 'response.output_text.delta', item_id: 'm1', delta: 'ok' },
        { type: 'response.completed', response: {} },
      ]),
    );
    const text = events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe('ok');
    expect(events.at(-1)?.type).toBe('message_stop');
  });
});
