import { anthropicAdapter, createAnthropicAdapter } from './anthropic';
import { SerializationError } from './adapter';
import { canonRequest, canonResponse } from './canon';
import type { NormalizedRequest } from './ir';
import plain from './golden/anthropic/plain.json';
import tools from './golden/anthropic/tools-multiturn.json';
import multimodal from './golden/anthropic/multimodal.json';

const a = anthropicAdapter;

function roundTripRequest(wire: unknown): void {
  const ir = a.requestIn(wire);
  const back = a.requestOut(ir);
  expect(a.requestIn(back)).toEqual(ir);
  expect(canonRequest('anthropic', back)).toEqual(canonRequest('anthropic', wire));
}

function roundTripResponse(wire: unknown): void {
  const ir = a.responseIn(wire);
  const back = a.responseOut(ir);
  expect(a.responseIn(back)).toEqual(ir);
  expect(canonResponse('anthropic', back)).toEqual(canonResponse('anthropic', wire));
}

describe('Anthropic adapter — request round-trip', () => {
  it('plain (top-level system + user)', () => roundTripRequest(plain.request));
  it('multi-turn parallel tools with error result + trailing text', () =>
    roundTripRequest(tools.request));
  it('multimodal base64 image', () => roundTripRequest(multimodal.request));

  it('splits a tool-result user turn into per-result tool messages + trailing user text', () => {
    const ir = a.requestIn(tools.request);
    const roles = ir.messages.map((m) => m.role);
    // user, assistant(2 tool_use), tool, tool, user(trailing text), assistant
    expect(roles).toEqual(['user', 'assistant', 'tool', 'tool', 'user', 'assistant']);
    const trailing = ir.messages[4];
    expect(trailing?.content).toEqual([{ type: 'text', text: 'Now summarize both cities.' }]);
  });

  it('regroups tool results (results first) + trailing text into one user message', () => {
    const back = a.requestOut(a.requestIn(tools.request)) as {
      messages: { role: string; content: { type: string; is_error?: boolean }[] }[];
    };
    const grouped = back.messages[2];
    expect(grouped?.role).toBe('user');
    expect(grouped?.content.map((b) => b.type)).toEqual(['tool_result', 'tool_result', 'text']);
    expect(grouped?.content[1]?.is_error).toBe(true);
  });

  it('maps tool_choice any ⟷ required', () => {
    const ir = a.requestIn({ ...tools.request, tool_choice: { type: 'any' } });
    expect(ir.toolChoice).toBe('required');
    const back = a.requestOut(ir) as { tool_choice?: { type: string } };
    expect(back.tool_choice?.type).toBe('any');
  });
});

describe('Anthropic adapter — response round-trip', () => {
  it('plain response with cache tokens', () => roundTripResponse(plain.response));
  it('tool-use response', () => roundTripResponse(tools.response));

  it('usage carries cache read and write components', () => {
    const ir = a.responseIn(plain.response);
    expect(ir.usage).toEqual({
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
    });
  });
});

describe('Anthropic adapter — max_tokens resolution', () => {
  const irNoMax: NormalizedRequest = {
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    params: {},
  };

  it('resolves from a configured default when the IR omits it', () => {
    const withDefault = createAnthropicAdapter({}, { defaultMaxOutputTokens: 4096 });
    expect((withDefault.requestOut(irNoMax) as { max_tokens: number }).max_tokens).toBe(4096);
  });

  it('throws a structured error when neither IR value nor default exists', () => {
    expect(() => a.requestOut(irNoMax)).toThrow(SerializationError);
  });
});
