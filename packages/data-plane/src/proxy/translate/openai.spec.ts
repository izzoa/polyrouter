import { openaiAdapter } from './openai';
import { canonRequest, canonResponse } from './canon';
import type { NormalizedResponse, ToolUseBlock } from './ir';
import plain from './golden/openai/plain.json';
import tools from './golden/openai/tools-multiturn.json';
import multimodal from './golden/openai/multimodal.json';
import malformed from './golden/openai/malformed-tool.json';

const a = openaiAdapter;

function roundTripRequest(wire: unknown): void {
  const ir = a.requestIn(wire);
  const back = a.requestOut(ir);
  // IR-level: no information the IR models is lost across the wire.
  expect(a.requestIn(back)).toEqual(ir);
  // wire-level: canonical equivalence (content/arg/spelling encodings aside).
  expect(canonRequest('openai', back)).toEqual(canonRequest('openai', wire));
}

function roundTripResponse(wire: unknown): void {
  const ir = a.responseIn(wire);
  const back = a.responseOut(ir);
  expect(a.responseIn(back)).toEqual(ir);
  expect(canonResponse('openai', back)).toEqual(canonResponse('openai', wire));
}

describe('OpenAI adapter — request round-trip', () => {
  it('plain (system + user)', () => roundTripRequest(plain.request));
  it('multi-turn parallel tools + trailing user text', () => roundTripRequest(tools.request));
  it('multimodal data-URL image with detail', () => roundTripRequest(multimodal.request));
  it('remote image URL preserved', () => roundTripRequest(multimodal.remoteImageRequest));

  it('extracts the system message into the IR system field', () => {
    const ir = a.requestIn(plain.request);
    expect(ir.system).toEqual([{ type: 'text', text: 'You are a terse assistant.' }]);
    expect(ir.messages.some((m) => m.role === 'assistant' || m.role === 'user')).toBe(true);
    expect(ir.messages.find((m) => (m.role as string) === 'system')).toBeUndefined();
  });

  it('preserves tool_choice and parallel control', () => {
    const ir = a.requestIn(tools.request);
    expect(ir.toolChoice).toBe('auto');
    expect(ir.allowParallelTools).toBe(true);
  });

  it('carries parsed tool input as an object (not a string)', () => {
    const ir = a.requestIn(tools.request);
    const assistant = ir.messages.find((m) => m.role === 'assistant');
    const toolUse = assistant?.content.find((b) => b.type === 'tool_use') as
      ToolUseBlock | undefined;
    expect(toolUse && 'input' in toolUse ? toolUse.input : null).toEqual({ city: 'SF' });
  });

  it('detail survives an OpenAI same-protocol round-trip', () => {
    const back = a.requestOut(a.requestIn(multimodal.request)) as {
      messages: { content: { type: string; image_url?: { detail?: string } }[] }[];
    };
    const img = back.messages[0]?.content.find((p) => p.type === 'image_url');
    expect(img?.image_url?.detail).toBe('high');
  });

  it('remote image URL is carried as a url block, not fetched', () => {
    const ir = a.requestIn(multimodal.remoteImageRequest);
    const img = ir.messages[0]?.content.find((b) => b.type === 'image');
    expect(img && 'url' in img ? img.url : null).toBe('https://example.com/cat.png');
  });
});

describe('OpenAI adapter — response round-trip', () => {
  it('plain response with cache tokens', () => roundTripResponse(plain.response));
  it('tool-call response', () => roundTripResponse(tools.response));

  it('finish_reason tool_calls → tool_use with raw preserved', () => {
    const ir = a.responseIn(tools.response);
    expect(ir.stopReason).toBe('tool_use');
    expect(ir.rawStopReason).toBe('tool_calls');
  });

  it('usage uses uncached components', () => {
    const ir: NormalizedResponse = a.responseIn(plain.response);
    expect(ir.usage).toEqual({ inputTokens: 20, outputTokens: 5, cacheReadTokens: 80 });
  });
});

describe('OpenAI adapter — malformed tool JSON', () => {
  it('is represented as inputParseError, never thrown, and re-emits raw', () => {
    const ir = a.responseIn(malformed.response);
    const block = ir.content.find((b) => b.type === 'tool_use') as ToolUseBlock;
    expect('inputParseError' in block && block.inputParseError).toBe(true);
    expect('inputRaw' in block ? block.inputRaw : null).toBe('{ "city": ');
    const back = a.responseOut(ir) as {
      choices: { message: { tool_calls?: { function: { arguments: string } }[] } }[];
    };
    expect(back.choices[0]?.message.tool_calls?.[0]?.function.arguments).toBe('{ "city": ');
  });
});

describe('OpenAI adapter — created serialization policy', () => {
  it('uses IR created when present, else context, else 0 — never the clock', () => {
    const irNoCreated: NormalizedResponse = {
      id: 'x',
      model: 'gpt-4o',
      content: [{ type: 'text', text: 'hi' }],
      stopReason: 'stop',
    };
    expect((a.responseOut(irNoCreated) as { created: number }).created).toBe(0);
    expect(
      (a.responseOut(irNoCreated, { created: 1700000000 }) as { created: number }).created,
    ).toBe(1700000000);
  });
});
