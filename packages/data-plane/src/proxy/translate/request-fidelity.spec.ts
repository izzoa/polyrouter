// E2 request-fidelity: no block fusion (E2.3), cache_control passthrough (E2.4),
// response_format + source-tagged reasoning (E2.5), temperature clamp (E2.9).
import { openaiAdapter } from './openai';
import { anthropicAdapter } from './anthropic';
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
