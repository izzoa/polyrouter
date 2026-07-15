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
