// E2 request-fidelity: no block fusion (E2.3), cache_control passthrough (E2.4),
// response_format + source-tagged reasoning (E2.5), temperature clamp (E2.9).
import { openaiAdapter, createOpenaiAdapter } from './openai';
import { anthropicAdapter } from './anthropic';
import { createResponsesAdapter } from './responses';
import { canonRequest } from './canon';
import type { AntRequest } from './wire/anthropic';
import type { OaiRequest } from './wire/openai';

const oai = openaiAdapter;
const ant = anthropicAdapter;

describe('E2.3 — multi-block content/system is not fused', () => {
  it('Anthropic: a two-block system round-trips as a block array, not a fused string', () => {
    const wire = {
      model: 'claude',
      max_tokens: 100,
      system: [
        { type: 'text', text: 'You are a reviewer.' },
        { type: 'text', text: 'Rules: never approve secrets.' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    };
    const out = ant.requestOut(ant.requestIn(wire)) as AntRequest;
    expect(Array.isArray(out.system)).toBe(true);
    expect(out.system).toHaveLength(2);
    // Not fused into 'You are a reviewer.Rules: never approve secrets.'
    expect(typeof out.system).not.toBe('string');
    // Canonical round-trip still holds.
    expect(canonRequest('anthropic', out)).toEqual(canonRequest('anthropic', wire));
  });

  it('OpenAI: a two-text-part user message round-trips as parts, not a fused string', () => {
    const wire = {
      model: 'gpt',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'First para.' },
            { type: 'text', text: 'Second para.' },
          ],
        },
      ],
    };
    const out = oai.requestOut(oai.requestIn(wire)) as OaiRequest;
    const content = out.messages[0]!.content;
    expect(Array.isArray(content)).toBe(true); // not 'First para.Second para.'
    expect(canonRequest('openai', out)).toEqual(canonRequest('openai', wire));
  });
});

describe('E2.4 — cache_control passthrough (same-protocol)', () => {
  it('survives an Anthropic round-trip on a system block and a tool', () => {
    const wire = {
      model: 'claude',
      max_tokens: 100,
      system: [{ type: 'text', text: 'big stable prompt', cache_control: { type: 'ephemeral' } }],
      tools: [
        {
          name: 'get_weather',
          input_schema: { type: 'object' },
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    };
    const out = ant.requestOut(ant.requestIn(wire)) as AntRequest;
    expect((out.system as { cache_control?: unknown }[])[0]!.cache_control).toEqual({
      type: 'ephemeral',
    });
    expect(out.tools![0]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('is dropped (not fabricated) when crossing to OpenAI', () => {
    const ir = ant.requestIn({
      model: 'claude',
      max_tokens: 100,
      system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    const out = oai.requestOut(ir) as OaiRequest;
    expect(JSON.stringify(out)).not.toContain('cache_control');
  });
});

describe('E2.5 — response_format + source-tagged reasoning', () => {
  const withMax = { max_completion_tokens: 100 };
  it('OpenAI response_format + reasoning_effort survive OpenAI→OpenAI', () => {
    const wire = {
      model: 'gpt',
      ...withMax,
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_schema', json_schema: { name: 'x', schema: {} } },
      reasoning_effort: 'high',
    };
    const out = oai.requestOut(oai.requestIn(wire)) as OaiRequest;
    expect(out.response_format).toEqual(wire.response_format);
    expect(out.reasoning_effort).toBe('high');
  });

  it('OpenAI reasoning is DROPPED crossing to Anthropic (no thinking fabricated)', () => {
    const ir = oai.requestIn({
      model: 'gpt',
      ...withMax,
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'high',
    });
    const out = ant.requestOut(ir) as AntRequest;
    expect(out.thinking).toBeUndefined();
  });

  it('Anthropic thinking survives Anthropic→Anthropic and is DROPPED crossing to OpenAI', () => {
    const ir = ant.requestIn({
      model: 'claude',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: 1024 },
    });
    const antOut = ant.requestOut(ir) as AntRequest;
    expect(antOut.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    const oaiOut = oai.requestOut(ir) as OaiRequest;
    expect(oaiOut.reasoning_effort).toBeUndefined();
    expect(JSON.stringify(oaiOut)).not.toContain('thinking');
  });

  it('Anthropic output_config survives Anthropic→Anthropic verbatim and is DROPPED crossing to OpenAI (add-auto-hint-features)', () => {
    const outputConfig = {
      effort: 'xhigh',
      format: { type: 'json_schema', schema: { type: 'object' } },
    };
    const ir = ant.requestIn({
      model: 'claude',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      output_config: outputConfig,
    });
    expect(ir.outputConfig).toEqual({ protocol: 'anthropic', value: outputConfig });
    const antOut = ant.requestOut(ir) as AntRequest & { output_config?: unknown };
    expect(antOut.output_config).toEqual(outputConfig); // opaque, verbatim
    const oaiOut = oai.requestOut(ir) as OaiRequest;
    expect(JSON.stringify(oaiOut)).not.toContain('output_config'); // documented drop, nothing fabricated
    expect(oaiOut.response_format).toBeUndefined();
  });
});

describe('E2.4/E2.3 — a non-text system block is skipped, not emitted as an empty block', () => {
  it('drops an anomalous non-text system block instead of producing empty text', () => {
    const ir = {
      model: 'claude',
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
      params: { maxOutputTokens: 100 },
      system: [{ type: 'image' as const, url: 'https://x/y.png' }],
    };
    const out = ant.requestOut(ir) as AntRequest;
    expect(out.system).toBeUndefined(); // no empty {type:'text',text:''} block
  });
});

describe('E2.9 — temperature clamp to Anthropic range', () => {
  it('clamps an out-of-range OpenAI temperature and passes in-range through', () => {
    const hot = oai.requestIn({
      model: 'gpt',
      max_completion_tokens: 100,
      temperature: 1.5,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect((ant.requestOut(hot) as AntRequest).temperature).toBe(1);
    const warm = oai.requestIn({
      model: 'gpt',
      max_completion_tokens: 100,
      temperature: 0.7,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect((ant.requestOut(warm) as AntRequest).temperature).toBe(0.7);
  });
});

describe('max-tokens spelling — per-provider outbound field (add-max-tokens-spelling)', () => {
  const ir = oai.requestIn({
    model: 'gpt',
    max_completion_tokens: 256,
    messages: [{ role: 'user', content: 'hi' }],
  });

  it('defaults to max_completion_tokens and never emits max_tokens', () => {
    const out = oai.requestOut(ir) as OaiRequest;
    expect(out.max_completion_tokens).toBe(256);
    expect(out.max_tokens).toBeUndefined();
  });

  it('the max_tokens option emits max_tokens and never max_completion_tokens', () => {
    const legacy = createOpenaiAdapter({ maxTokensSpelling: 'max_tokens' });
    const out = legacy.requestOut(ir) as OaiRequest;
    expect(out.max_tokens).toBe(256);
    expect(out.max_completion_tokens).toBeUndefined();
  });

  it('an explicit max_completion_tokens option matches the default', () => {
    const modern = createOpenaiAdapter({ maxTokensSpelling: 'max_completion_tokens' });
    const out = modern.requestOut(ir) as OaiRequest;
    expect(out.max_completion_tokens).toBe(256);
    expect(out.max_tokens).toBeUndefined();
  });

  it('never emits BOTH spellings, for either option', () => {
    for (const spelling of ['max_completion_tokens', 'max_tokens'] as const) {
      const out = createOpenaiAdapter({ maxTokensSpelling: spelling }).requestOut(ir) as OaiRequest;
      expect(out.max_tokens !== undefined && out.max_completion_tokens !== undefined).toBe(false);
    }
  });

  it('requestIn accepts either inbound spelling, independent of the outbound option', () => {
    expect(
      oai.requestIn({ model: 'gpt', max_tokens: 128, messages: [] }).params.maxOutputTokens,
    ).toBe(128);
    const legacy = createOpenaiAdapter({ maxTokensSpelling: 'max_tokens' });
    expect(
      legacy.requestIn({ model: 'gpt', max_completion_tokens: 64, messages: [] }).params
        .maxOutputTokens,
    ).toBe(64);
  });

  it('when both inbound spellings are present, max_completion_tokens wins (incl. 0)', () => {
    expect(
      oai.requestIn({ model: 'gpt', max_completion_tokens: 10, max_tokens: 999, messages: [] })
        .params.maxOutputTokens,
    ).toBe(10);
    // A modern value of 0 still wins over a legacy value (nullish-coalescing, not truthiness).
    expect(
      oai.requestIn({ model: 'gpt', max_completion_tokens: 0, max_tokens: 999, messages: [] })
        .params.maxOutputTokens,
    ).toBe(0);
  });
});

// Tool schemas are normalized on the way into the IR (fix-tool-schema-null-keywords). Every
// assertion below is on the object `requestOut` returns, before any stringify, and a removed
// keyword is asserted as key absence, never as `undefined`.
describe('fix-tool-schema-null-keywords: tool schema nulls never reach an upstream', () => {
  const responses = createResponsesAdapter();

  type ToolOut = { function: { name: string; parameters: Record<string, unknown> } };

  const deepFreeze = <T>(value: T): T => {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const v of Object.values(value)) deepFreeze(v);
    }
    return value;
  };

  // The Warp shape: an object schema whose `required` is null, after clean siblings.
  const warpSchema = (): Record<string, unknown> =>
    JSON.parse(
      '{"type":"object","properties":{"summary":{"type":"string"}},"required":null,"additionalProperties":false}',
    ) as Record<string, unknown>;

  const antBody = (): Record<string, unknown> => ({
    model: 'claude',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      {
        name: 'search',
        input_schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      },
      { name: 'finish', input_schema: warpSchema() },
      { name: 'transfer_control_to_user', input_schema: warpSchema() },
    ],
  });

  it('Anthropic client -> OpenAI requestOut: neither Warp tool has a required key', () => {
    const out = oai.requestOut(ant.requestIn(antBody())) as { tools: ToolOut[] };
    expect(out.tools.map((t) => t.function.name)).toEqual([
      'search',
      'finish',
      'transfer_control_to_user',
    ]);
    expect(out.tools[0]!.function.parameters).toStrictEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    });
    for (const t of out.tools.slice(1)) {
      expect(Object.hasOwn(t.function.parameters, 'required')).toBe(false);
      expect(t.function.parameters).toStrictEqual({
        type: 'object',
        properties: { summary: { type: 'string' } },
        additionalProperties: false,
      });
      expect(JSON.stringify(t.function.parameters)).toBe(
        '{"type":"object","properties":{"summary":{"type":"string"}},"additionalProperties":false}',
      );
    }
  });

  it('OpenAI client -> Anthropic requestOut: no null keyword in input_schema', () => {
    const nested = JSON.parse(
      '{"type":"object","description":null,"properties":{"a":{"type":"string"},"b":{"type":"array","items":null,"description":null}},"required":null,"anyOf":[{"type":"object"},{"required":null,"title":null}]}',
    ) as Record<string, unknown>;
    const out = ant.requestOut(
      oai.requestIn({
        model: 'gpt',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          { type: 'function', function: { name: 'ok', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'finish', parameters: nested } },
        ],
      }),
    ) as AntRequest;
    const schema = out.tools![1]!.input_schema as {
      properties: { b: Record<string, unknown> };
      anyOf: Record<string, unknown>[];
    } & Record<string, unknown>;
    for (const k of ['required', 'description']) {
      expect(Object.hasOwn(schema, k)).toBe(false);
    }
    expect(Object.hasOwn(schema.properties.b, 'items')).toBe(false);
    expect(Object.hasOwn(schema.properties.b, 'description')).toBe(false);
    expect(Object.hasOwn(schema.anyOf[1]!, 'required')).toBe(false);
    expect(Object.hasOwn(schema.anyOf[1]!, 'title')).toBe(false);
    expect(schema.properties.b).toStrictEqual({ type: 'array' });
    expect(schema.anyOf[0]).toStrictEqual({ type: 'object' });
    expect(out.tools![0]!.input_schema).toStrictEqual({ type: 'object' });
  });

  it('Anthropic and Responses requestOut from the same IR emit no required key', () => {
    const ir = ant.requestIn(antBody());
    const antOut = ant.requestOut(ir) as AntRequest;
    const respOut = responses.requestOut(ir) as {
      tools: { parameters: Record<string, unknown> }[];
    };
    for (const i of [1, 2]) {
      expect(Object.hasOwn(antOut.tools![i]!.input_schema, 'required')).toBe(false);
      expect(Object.hasOwn(respOut.tools[i]!.parameters, 'required')).toBe(false);
    }
    // The clean tool keeps its real required list on both.
    expect(antOut.tools![0]!.input_schema['required']).toStrictEqual(['q']);
    expect(respOut.tools[0]!.parameters['required']).toStrictEqual(['q']);
  });

  it('same-protocol Anthropic -> Anthropic: the null is removed and everything else matches', () => {
    const wire = antBody();
    const out = ant.requestOut(ant.requestIn(wire)) as AntRequest;
    for (const i of [1, 2]) {
      expect(Object.hasOwn(out.tools![i]!.input_schema, 'required')).toBe(false);
    }
    const expected = antBody();
    for (const t of (expected as { tools: { input_schema: Record<string, unknown> }[] }).tools) {
      delete t.input_schema['required'];
    }
    // The clean tool's real required list was deleted from `expected` above; restore it.
    (expected as { tools: { input_schema: Record<string, unknown> }[] }).tools[0]!.input_schema[
      'required'
    ] = ['q'];
    expect(canonRequest('anthropic', out)).toStrictEqual(canonRequest('anthropic', expected));
  });

  describe('a deeply frozen client body', () => {
    const nestedClean = (): Record<string, unknown> => ({
      type: 'object',
      properties: { city: { type: 'string', description: 'where' } },
    });

    it('Anthropic requestIn: the body is untouched, clean subtrees are shared', () => {
      const clean = { type: 'object', properties: { q: { type: 'string' } } };
      const sibling = { type: 'string' };
      const anyOf0 = { type: 'object' };
      const body = deepFreeze({
        model: 'claude',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          { name: 'clean', input_schema: clean },
          {
            name: 'dirty',
            input_schema: {
              type: 'object',
              properties: { keep: sibling, bad: { type: 'string', description: null } },
              anyOf: [anyOf0, { required: null }],
              required: null,
            },
          },
        ],
      });
      const snapshot = structuredClone(body);
      const ir = ant.requestIn(body);
      expect(body).toStrictEqual(snapshot);
      const [cleanTool, dirtyTool] = ir.tools!;
      expect(cleanTool!.parameters).toBe(clean);
      expect(Object.hasOwn(dirtyTool!.parameters, 'required')).toBe(false);
      const props = dirtyTool!.parameters['properties'] as Record<string, Record<string, unknown>>;
      expect(Object.hasOwn(props['bad']!, 'description')).toBe(false);
      expect(props['keep']).toBe(sibling);
      const anyOf = dirtyTool!.parameters['anyOf'] as Record<string, unknown>[];
      expect(Object.hasOwn(anyOf[1]!, 'required')).toBe(false);
      expect(anyOf[0]).toBe(anyOf0);
    });

    it('OpenAI requestIn: the body is untouched, clean subtrees are shared', () => {
      const clean = nestedClean();
      const sibling = { type: 'string' };
      const anyOf0 = { type: 'object' };
      const body = deepFreeze({
        model: 'gpt',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          { type: 'function', function: { name: 'clean', parameters: clean } },
          {
            type: 'function',
            function: {
              name: 'dirty',
              parameters: {
                type: 'object',
                properties: { keep: sibling, bad: { type: 'string', description: null } },
                anyOf: [anyOf0, { required: null }],
                required: null,
              },
            },
          },
        ],
      });
      const snapshot = structuredClone(body);
      const ir = oai.requestIn(body);
      expect(body).toStrictEqual(snapshot);
      const [cleanTool, dirtyTool] = ir.tools!;
      expect(cleanTool!.parameters).toBe(clean);
      expect(Object.hasOwn(dirtyTool!.parameters, 'required')).toBe(false);
      const props = dirtyTool!.parameters['properties'] as Record<string, Record<string, unknown>>;
      expect(Object.hasOwn(props['bad']!, 'description')).toBe(false);
      expect(props['keep']).toBe(sibling);
      const anyOf = dirtyTool!.parameters['anyOf'] as Record<string, unknown>[];
      expect(Object.hasOwn(anyOf[1]!, 'required')).toBe(false);
      expect(anyOf[0]).toBe(anyOf0);
    });
  });
});
