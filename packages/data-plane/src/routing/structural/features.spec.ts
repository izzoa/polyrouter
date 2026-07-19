import {
  MAX_FINGERPRINT_CHARS,
  MAX_SCAN_CHARS,
  canonicalizeSystem,
  extractStructuralFeatures,
} from './features';
import type { NormalizedMessage, NormalizedRequest } from '../../proxy/translate';

function req(partial: Partial<NormalizedRequest>): NormalizedRequest {
  return { model: 'auto', messages: [], params: {}, ...partial };
}
function userText(text: string): NormalizedMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

describe('extractStructuralFeatures', () => {
  it('excludes the system block from the size signal (de-contamination)', () => {
    const f = extractStructuralFeatures(
      req({
        system: [{ type: 'text', text: 'X'.repeat(50_000) }],
        messages: [userText('hi')],
      }),
    );
    expect(f.effectiveInputChars).toBe(2); // "hi" only — the huge system is not measured
  });

  it('counts a terminal tool-result message (nested tool_result content)', () => {
    const f = extractStructuralFeatures(
      req({
        messages: [
          userText('run the tool'),
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f', input: {} }] },
          {
            role: 'tool',
            content: [
              {
                type: 'tool_result',
                toolUseId: 't1',
                content: [{ type: 'text', text: 'R'.repeat(500) }],
              },
            ],
          },
        ],
      }),
    );
    expect(f.effectiveInputChars).toBe(12 + 500); // user turn + nested tool-result text
    expect(f.conversationDepth).toBe(3);
  });

  it('counts fenced code spans', () => {
    const f = extractStructuralFeatures(req({ messages: [userText('a\n```\ncode\n```\nb')] }));
    expect(f.codeBlockChars).toBeGreaterThan(0);
  });

  it('counts tools and detects a non-empty parameter schema', () => {
    const withSchema = extractStructuralFeatures(
      req({
        messages: [userText('go')],
        tools: [{ name: 'a', parameters: { type: 'object', properties: {} } }],
      }),
    );
    expect(withSchema.toolCount).toBe(1);
    expect(withSchema.toolSchemaDemand).toBe(true);

    const noSchema = extractStructuralFeatures(
      req({ messages: [userText('go')], tools: [{ name: 'a', parameters: {} }] }),
    );
    expect(noSchema.toolSchemaDemand).toBe(false);
  });

  it('detects multimodal content and reads max output tokens', () => {
    const f = extractStructuralFeatures(
      req({
        messages: [
          { role: 'user', content: [{ type: 'image', data: 'abc', mediaType: 'image/png' }] },
        ],
        params: { maxOutputTokens: 2048 },
      }),
    );
    expect(f.multimodalPresent).toBe(true);
    expect(f.maxOutputTokens).toBe(2048);
  });

  it('bounds the scan and only measures the recent window', () => {
    const many: NormalizedMessage[] = Array.from({ length: 20 }, (_, i) => userText(`m${i}`));
    const f = extractStructuralFeatures(req({ messages: many }));
    expect(f.conversationDepth).toBe(20); // depth is the full count
    // ...but only the last RECENT_WINDOW messages contribute to size.
    expect(f.effectiveInputChars).toBeLessThan(20 * 3);

    const huge = extractStructuralFeatures(req({ messages: [userText('Y'.repeat(100_000))] }));
    expect(huge.effectiveInputChars).toBe(MAX_SCAN_CHARS);
  });
});

describe('declared-signal extraction (add-auto-hint-features)', () => {
  const demand = (partial: Partial<NormalizedRequest>): number | null =>
    extractStructuralFeatures(req(partial)).reasoningDemand;
  const rf = (partial: Partial<NormalizedRequest>): boolean =>
    extractStructuralFeatures(req(partial)).responseFormatDemand;

  it('maps the OpenAI effort enum exactly — including xhigh and max', () => {
    const at = (effort: unknown) => demand({ reasoning: { protocol: 'openai', effort } });
    expect(at('none')).toBe(0);
    expect(at('minimal')).toBe(0.25);
    expect(at('low')).toBe(0.5);
    expect(at('medium')).toBe(0.75);
    expect(at('high')).toBe(1);
    expect(at('xhigh')).toBe(1);
    expect(at('max')).toBe(1);
  });

  it('ONE uniform junk rule: present-but-unrecognized → 0.5 (exact raw comparison, no normalization)', () => {
    const at = (effort: unknown) => demand({ reasoning: { protocol: 'openai', effort } });
    expect(at('HIGH')).toBe(0.5); // case variant is junk, never NL-normalized
    expect(at('turbo')).toBe(0.5);
    expect(at(7)).toBe(0.5); // wrong type, but the field is DECLARED
    // Prototype-chain names must hit the junk rule, never an inherited function (r3).
    expect(at('constructor')).toBe(0.5);
    expect(at('toString')).toBe(0.5);
    expect(at('__proto__')).toBe(0.5);
    expect(at('hasOwnProperty')).toBe(0.5);
    expect(demand({ reasoning: { protocol: 'anthropic', thinking: { type: 'mystery' } } })).toBe(
      0.5,
    );
    expect(demand({ reasoning: { protocol: 'anthropic', thinking: 'shapeless' } })).toBe(0.5);
  });

  it('maps Anthropic thinking: enabled budgets saturate at 16k; adaptive 0.5; disabled 0', () => {
    const at = (thinking: unknown) => demand({ reasoning: { protocol: 'anthropic', thinking } });
    expect(at({ type: 'enabled', budget_tokens: 32_000 })).toBe(1);
    expect(at({ type: 'enabled', budget_tokens: 16_000 })).toBe(1); // exact saturation → rule-triggering 1
    expect(at({ type: 'enabled', budget_tokens: 15_999 })).toBeLessThan(1); // just below never triggers
    expect(at({ type: 'enabled', budget_tokens: 4_000 })).toBe(0.5); // the 0.5 floor
    expect(at({ type: 'enabled' })).toBe(0.5); // declared, unquantified
    expect(at({ type: 'adaptive' })).toBe(0.5);
    expect(at({ type: 'disabled' })).toBe(0); // an explicit decline
  });

  it('absence everywhere is NULL — distinct from declared none/disabled', () => {
    expect(demand({})).toBeNull();
    expect(demand({ reasoning: { protocol: 'openai', effort: 'none' } })).toBe(0);
  });

  it('reads output_config structurally: effort enum incl. xhigh; shapeless = absent; format = demand', () => {
    const oc = (value: unknown) => demand({ outputConfig: { protocol: 'anthropic', value } });
    expect(oc({ effort: 'low' })).toBe(0.5);
    expect(oc({ effort: 'medium' })).toBe(0.75);
    expect(oc({ effort: 'high' })).toBe(1);
    expect(oc({ effort: 'xhigh' })).toBe(1);
    expect(oc({ effort: 'max' })).toBe(1);
    expect(oc({ effort: 'MAX' })).toBe(0.5); // junk rule
    expect(oc({ effort: 'valueOf' })).toBe(0.5); // prototype-chain junk (r3)
    expect(oc('shapeless')).toBeNull(); // non-object output_config contributes NOTHING
    expect(oc({ format: { type: 'json_schema' } })).toBeNull(); // format alone is no effort signal
    expect(rf({ outputConfig: { protocol: 'anthropic', value: { format: {} } } })).toBe(true);
    expect(rf({ outputConfig: { protocol: 'anthropic', value: {} } })).toBe(false);
    // An explicit `format: null` declares NO format (delta: non-null presence).
    expect(rf({ outputConfig: { protocol: 'anthropic', value: { format: null } } })).toBe(false);
  });

  it('multiple sources take their MAX', () => {
    expect(
      demand({
        reasoning: { protocol: 'anthropic', thinking: { type: 'disabled' } }, // 0
        outputConfig: { protocol: 'anthropic', value: { effort: 'medium' } }, // .75
      }),
    ).toBe(0.75);
  });

  it('maps response_format structurally: json_schema/json_object → demand; text/shapeless → none', () => {
    expect(rf({ responseFormat: { type: 'json_schema', json_schema: {} } })).toBe(true);
    expect(rf({ responseFormat: { type: 'json_object' } })).toBe(true);
    expect(rf({ responseFormat: { type: 'text' } })).toBe(false);
    expect(rf({ responseFormat: 'shapeless' })).toBe(false);
    expect(rf({})).toBe(false);
  });
});

describe('canonicalizeSystem', () => {
  it('is framing-sensitive: [A][B] differs from [AB]', () => {
    const split = canonicalizeSystem(
      req({
        system: [
          { type: 'text', text: 'A' },
          { type: 'text', text: 'B' },
        ],
      }),
    );
    const joined = canonicalizeSystem(req({ system: [{ type: 'text', text: 'AB' }] }));
    expect(split).not.toBe(joined);
  });

  it('is empty when there is no system block', () => {
    expect(canonicalizeSystem(req({}))).toBe('');
    expect(canonicalizeSystem(req({ system: [] }))).toBe('');
  });

  it('caps the canonical length', () => {
    const c = canonicalizeSystem(req({ system: [{ type: 'text', text: 'Z'.repeat(200_000) }] }));
    expect(c.length).toBeLessThanOrEqual(MAX_FINGERPRINT_CHARS);
  });
});
