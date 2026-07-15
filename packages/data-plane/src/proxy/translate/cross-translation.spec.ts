import { openaiAdapter } from './openai';
import { anthropicAdapter } from './anthropic';
import { canonRequest } from './canon';
import type { ContentBlock, NormalizedResponse, NormalizedUsage } from './ir';
import oaiTools from './golden/openai/tools-multiturn.json';
import oaiPlain from './golden/openai/plain.json';
import antTools from './golden/anthropic/tools-multiturn.json';
import antPlain from './golden/anthropic/plain.json';

const oai = openaiAdapter;
const ant = anthropicAdapter;

describe('cross-translation — request (OpenAI → Anthropic)', () => {
  const ir = oai.requestIn(oaiTools.request);
  const antWire = ant.requestOut(ir) as {
    system?: string;
    tools?: { name: string; input_schema: unknown }[];
    tool_choice?: { type: string };
    messages: { role: string; content: { type: string; input?: unknown }[] }[];
  };

  it('relocates the system prompt to the top-level system field', () => {
    expect(antWire.system).toBe('Use tools when helpful.');
    expect(antWire.messages.some((m) => m.role === 'system')).toBe(false);
  });

  it('maps tools with input_schema and preserves tool_choice', () => {
    expect(antWire.tools?.[0]?.name).toBe('get_weather');
    expect(antWire.tools?.[0]?.input_schema).toEqual(
      oaiTools.request.tools[0]?.function.parameters,
    );
    expect(antWire.tool_choice?.type).toBe('auto');
  });

  it('groups the parallel tool results + trailing text into one user message', () => {
    const grouped = antWire.messages.find(
      (m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result'),
    );
    expect(grouped?.content.map((b) => b.type)).toEqual(['tool_result', 'tool_result', 'text']);
  });

  it('keeps parallel tool_use inputs as parsed objects', () => {
    const assistant = antWire.messages.find(
      (m) => m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use'),
    );
    const inputs = assistant?.content.filter((b) => b.type === 'tool_use').map((b) => b.input);
    expect(inputs).toEqual([{ city: 'SF' }, { city: 'NYC' }]);
  });
});

describe('cross-translation — request (Anthropic → OpenAI)', () => {
  const ir = ant.requestIn(antTools.request);
  const oaiWire = oai.requestOut(ir) as {
    messages: {
      role: string;
      content: unknown;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
      tool_call_id?: string;
    }[];
  };

  it('emits one OpenAI tool message per tool_call_id', () => {
    const toolMsgs = oaiWire.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(['toolu_sf', 'toolu_nyc']);
  });

  it('preserves tool-call ids and parsed arguments on the assistant turn', () => {
    const assistant = oaiWire.messages.find((m) => m.role === 'assistant' && m.tool_calls);
    expect(assistant?.tool_calls?.map((c) => c.id)).toEqual(['toolu_sf', 'toolu_nyc']);
    expect(assistant?.tool_calls?.map((c) => JSON.parse(c.function.arguments))).toEqual([
      { city: 'SF' },
      { city: 'NYC' },
    ]);
  });

  it('drops the tool_result error flag (OpenAI has no such field) — documented', () => {
    // is_error:true on the Anthropic side has no OpenAI representation.
    const irBlock = ir.messages
      .filter((m) => m.role === 'tool')
      .flatMap((m) => m.content)
      .find(
        (b): b is Extract<ContentBlock, { type: 'tool_result' }> =>
          b.type === 'tool_result' && b.isError === true,
      );
    expect(irBlock).toBeDefined();
    const back = oai.requestIn(oaiWire);
    const backHasError = back.messages
      .filter((m) => m.role === 'tool')
      .flatMap((m) => m.content)
      .some((b) => b.type === 'tool_result' && b.isError === true);
    expect(backHasError).toBe(false);
  });
});

describe('cross-translation — full multi-turn round-trip (OpenAI → Anthropic → OpenAI)', () => {
  it('is canonically equivalent in message substance (ids, results, order, inputs)', () => {
    const ir1 = oai.requestIn(oaiTools.request);
    const antWire = ant.requestOut(ir1);
    const ir2 = ant.requestIn(antWire);
    const oaiWire2 = oai.requestOut(ir2);
    // Compare the message substance (top-level control params like
    // parallel_tool_calls have known cross-protocol impedance and are excluded).
    expect(canonRequest('openai', oaiWire2)['messages']).toEqual(
      canonRequest('openai', oaiTools.request)['messages'],
    );
  });
});

describe('cross-translation — response usage matrix', () => {
  function usageOf(res: NormalizedResponse): NormalizedUsage | undefined {
    return res.usage;
  }

  it('Anthropic response (fresh+read+write) → OpenAI usage', () => {
    const ir = ant.responseIn(antPlain.response);
    const oaiWire = oai.responseOut(ir) as { usage?: unknown };
    expect(oaiWire.usage).toEqual({
      prompt_tokens: 110,
      completion_tokens: 5,
      total_tokens: 115,
      prompt_tokens_details: { cached_tokens: 80 },
    });
  });

  it('OpenAI response (prompt incl. cached) → Anthropic usage components', () => {
    const ir = oai.responseIn(oaiPlain.response);
    const antWire = ant.responseOut(ir) as { usage?: unknown };
    expect(antWire.usage).toEqual({
      input_tokens: 20,
      output_tokens: 5,
      cache_read_input_tokens: 80,
    });
  });

  it('canonical stop reason survives the cross even as raw changes', () => {
    const ir = oai.responseIn(oaiTools.response); // finish_reason tool_calls
    const antWire = ant.responseOut(ir) as { stop_reason: string };
    expect(antWire.stop_reason).toBe('tool_use');
    expect(usageOf(ant.responseIn(antWire))).toBeDefined();
  });

  it('no-usage response cross-translates to no usage, never zero', () => {
    const ir = oai.responseIn({
      id: 'x',
      object: 'chat.completion',
      created: 1,
      model: 'gpt-4o',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    });
    expect(ir.usage).toBeUndefined();
    const antWire = ant.responseOut(ir) as { usage?: unknown };
    expect(antWire.usage).toBeUndefined();
  });
});
