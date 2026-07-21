import type { NormalizedRequest } from '../proxy/translate/ir';
import { extractSemanticInput } from './extract';

const req = (over: Partial<NormalizedRequest>): NormalizedRequest => ({
  model: 'auto',
  messages: [],
  params: {},
  ...over,
});

const text = (t: string) => ({ type: 'text' as const, text: t });
const user = (t: string) => ({ role: 'user' as const, content: [text(t)] });
const assistant = (t: string) => ({ role: 'assistant' as const, content: [text(t)] });

describe('extractSemanticInput v1 (goldens)', () => {
  it('serializes newest user turn FIRST, then prior context newest-first', () => {
    const ir = req({
      messages: [user('first question'), assistant('first answer'), user('newest question')],
    });
    expect(extractSemanticInput(ir, { totalChars: 2000 })).toBe(
      'user: newest question\nassistant: first answer\nuser: first question',
    );
  });

  it('EXCLUDES system content entirely', () => {
    const ir = req({
      system: [text('SYSTEM_SECRET rules')],
      messages: [user('hello')],
    });
    const out = extractSemanticInput(ir, { totalChars: 2000 });
    expect(out).toBe('user: hello');
    expect(out).not.toContain('SYSTEM_SECRET');
  });

  it('the newest turn SURVIVES a long old context (clink r1 High-3)', () => {
    const ir = req({
      messages: [user('x'.repeat(5000)), assistant('y'.repeat(5000)), user('THE NEWEST ASK')],
    });
    const out = extractSemanticInput(ir, { totalChars: 300 });
    expect(out.startsWith('user: THE NEWEST ASK')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(300);
  });

  it('a huge lone newest turn is head-kept at the total cap', () => {
    const ir = req({ messages: [user('A'.repeat(5000))] });
    const out = extractSemanticInput(ir, { totalChars: 100, perMessageChars: 5000 });
    expect(out).toBe(`user: ${'A'.repeat(94)}`);
  });

  it('renders tool results, tool calls, and images as capped markers', () => {
    const ir = req({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'search', input: { q: 'x' } }],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolUseId: 't1',
              content: [text('result body'), { type: 'image', url: 'https://x/y.png' }],
            },
          ],
        },
        { role: 'user', content: [text('so?'), { type: 'image', url: 'https://x/z.png' }] },
      ],
    });
    expect(extractSemanticInput(ir, { totalChars: 2000 })).toBe(
      'user: so? [image]\ntool: [tool result] result body [image]\nassistant: [tool call search]',
    );
  });

  it('bounds traversal at maxMessages', () => {
    const ir = req({
      messages: [user('m1'), user('m2'), user('m3'), user('m4'), user('newest')],
    });
    const out = extractSemanticInput(ir, { totalChars: 2000, maxMessages: 2 });
    expect(out).toBe('user: newest\nuser: m4');
  });

  it('never emits more than totalChars', () => {
    const ir = req({
      messages: Array.from({ length: 20 }, (_, i) => user(`message number ${String(i)} padded out`)),
    });
    expect(extractSemanticInput(ir, { totalChars: 120 }).length).toBeLessThanOrEqual(120);
  });

  it('a system-only request renders NOTHING (router will skip; clink r2 Med-2)', () => {
    const ir = req({ system: [text('you are a helpful assistant')], messages: [] });
    expect(extractSemanticInput(ir, { totalChars: 2000 })).toBe('');
    // a message with no renderable content also contributes nothing
    const empty = req({ messages: [{ role: 'user', content: [] }] });
    expect(extractSemanticInput(empty, { totalChars: 2000 })).toBe('');
  });

  it('the newest turn gets the WHOLE budget, not the smaller per-prior-message cap (clink r2 Med-2)', () => {
    // Only totalChars is supplied (as the live router does); the default
    // per-prior-message cap (600) must NOT clip the newest turn.
    const ir = req({ messages: [user('N'.repeat(1500))] });
    const out = extractSemanticInput(ir, { totalChars: 2000 });
    expect(out.length).toBe('user: '.length + 1500);
  });

  it('bounds block traversal per message (clink r2 Med-2)', () => {
    const many = req({
      messages: [
        { role: 'user', content: Array.from({ length: 10_000 }, (_, i) => text(`b${String(i)}`)) },
      ],
    });
    // Does not hang / allocate unboundedly; output is capped.
    const out = extractSemanticInput(many, { totalChars: 200 });
    expect(out.length).toBeLessThanOrEqual(200);
  });
});
