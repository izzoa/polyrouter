import {
  BoundedBlockCollector,
  serializeClientRequest,
  serializeResponseContent,
  stripMediaDeep,
} from './body-capture';
import type { NormalizedStreamEvent } from './translate/ir';

describe('stripMediaDeep', () => {
  it('replaces base64 data URLs and Anthropic base64 source data with size markers', () => {
    const img = 'data:image/png;base64,' + 'A'.repeat(10_000);
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: img } }] },
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B'.repeat(5000) } },
          ],
        },
        { role: 'user', content: 'keep this text' },
      ],
    };
    const out = JSON.stringify(stripMediaDeep(body));
    expect(out).toContain('[media removed: 10000 bytes]');
    expect(out).toContain('[media removed: 5000 bytes]');
    expect(out).toContain('keep this text');
    expect(out).not.toContain('AAAA');
    expect(out).not.toContain('BBBB');
  });

  it('leaves ordinary strings and structures untouched', () => {
    const v = { a: ['data-driven', { data: 'not base64 typed' }], n: 3 };
    expect(stripMediaDeep(v)).toEqual(v);
  });
});

describe('serializeClientRequest — cap + honesty', () => {
  it('caps at the byte limit, reports the FULL pre-cap size, sets truncated', () => {
    const r = serializeClientRequest({ text: 'x'.repeat(2000) }, 128);
    expect(Buffer.byteLength(r.content, 'utf8')).toBeLessThanOrEqual(128);
    expect(r.bytes).toBeGreaterThan(2000);
    expect(r.truncated).toBe(true);
    const small = serializeClientRequest({ ok: true }, 1024);
    expect(small.truncated).toBe(false);
    expect(small.content).toBe('{"ok":true}');
  });

  it('never splits a multi-byte codepoint at the cap', () => {
    const r = serializeClientRequest({ text: '€'.repeat(500) }, 100);
    expect(r.content.endsWith('�')).toBe(false);
    expect(() => JSON.stringify(r.content)).not.toThrow();
  });
});

const ev = (e: NormalizedStreamEvent): NormalizedStreamEvent => e;

describe('BoundedBlockCollector — parity + bounds', () => {
  it('assembles text + finalized tool blocks identical to the buffered serialization', () => {
    const c = new BoundedBlockCollector(64 * 1024);
    c.onEvent(ev({ type: 'message_start', id: 'm', model: 'x', role: 'assistant' }));
    c.onEvent(ev({ type: 'text_delta', index: 0, text: 'Hello ' }));
    c.onEvent(ev({ type: 'text_delta', index: 0, text: 'world' }));
    c.onEvent(ev({ type: 'tool_use_start', index: 1, id: 't1', name: 'search' }));
    c.onEvent(ev({ type: 'tool_use_delta', index: 1, partialJson: '{"q":' }));
    c.onEvent(ev({ type: 'tool_use_delta', index: 1, partialJson: '"cats"}' }));
    c.onEvent(
      ev({
        type: 'block_stop',
        index: 1,
        finalizedToolUse: { type: 'tool_use', id: 't1', name: 'search', input: { q: 'cats' } },
      }),
    );
    c.onEvent(ev({ type: 'message_stop' }));
    const buffered = [
      { type: 'text' as const, text: 'Hello world' },
      { type: 'tool_use' as const, id: 't1', name: 'search', input: { q: 'cats' } },
    ];
    // THE canonical serializer gives byte-identical output for both paths.
    expect(serializeResponseContent(c.blocks(), 64 * 1024)).toEqual(
      serializeResponseContent(buffered, 64 * 1024),
    );
    expect(c.truncated).toBe(false);
  });

  it('stops RETAINING at the byte budget and flags truncation (the stream flows on)', () => {
    const c = new BoundedBlockCollector(32);
    for (let i = 0; i < 100; i += 1) c.onEvent(ev({ type: 'text_delta', index: 0, text: '0123456789' }));
    expect(c.truncated).toBe(true);
    const text = (c.blocks()[0] as { text: string }).text;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(32);
  });

  it('ignores the synthesized terminal error frame and message events', () => {
    const c = new BoundedBlockCollector(1024);
    c.onEvent(ev({ type: 'text_delta', index: 0, text: 'partial answer' }));
    c.onEvent(ev({ type: 'error', error: { type: 'overloaded', message: 'upstream fell over' } }));
    const out = serializeResponseContent(c.blocks(), 1024);
    expect(out.content).toContain('partial answer');
    expect(out.content).not.toContain('upstream fell over'); // not model output
  });

  it('a never-finalized tool block yields an empty input, never a throw', () => {
    const c = new BoundedBlockCollector(1024);
    c.onEvent(ev({ type: 'tool_use_start', index: 0, id: 't', name: 'fn' }));
    c.onEvent(ev({ type: 'tool_use_delta', index: 0, partialJson: '{"a": tru' })); // cut mid-stream
    expect(c.blocks()).toEqual([{ type: 'tool_use', id: 't', name: 'fn', input: {} }]);
  });

  it('hasContent gates the response row', () => {
    const c = new BoundedBlockCollector(1024);
    expect(c.hasContent).toBe(false);
    c.onEvent(ev({ type: 'text_delta', index: 0, text: 'x' }));
    expect(c.hasContent).toBe(true);
  });

  // Adversarial bounds (clink impl-High-2): every retained byte is charged.
  it('caps the slot count — index spam cannot grow the map', () => {
    const c = new BoundedBlockCollector(1024 * 1024);
    for (let i = 0; i < 10_000; i += 1) c.onEvent(ev({ type: 'text_delta', index: i, text: 'x' }));
    expect(c.blocks().length).toBeLessThanOrEqual(128);
    expect(c.truncated).toBe(true);
  });

  it('charges tool ids/names and refuses new slots past exhaustion', () => {
    const c = new BoundedBlockCollector(16);
    c.onEvent(ev({ type: 'tool_use_start', index: 0, id: 'toolid-0000', name: 'longname' })); // 19B > 16
    expect(c.blocks()).toHaveLength(0); // never admitted
    expect(c.truncated).toBe(true);
  });

  it('an oversized finalized tool input cannot bypass the budget', () => {
    const c = new BoundedBlockCollector(256);
    c.onEvent(ev({ type: 'tool_use_start', index: 0, id: 't', name: 'f' }));
    c.onEvent(ev({ type: 'tool_use_delta', index: 0, partialJson: '{"a":1}' }));
    c.onEvent(
      ev({
        type: 'block_stop',
        index: 0,
        finalizedToolUse: { type: 'tool_use', id: 't', name: 'f', input: { blob: 'X'.repeat(10_000) } },
      }),
    );
    const out = serializeResponseContent(c.blocks(), 1024 * 1024);
    expect(out.content).not.toContain('XXXX'); // the unrestricted block was refused
    expect(c.truncated).toBe(true);
    expect(out.content).toContain('"a":1'); // the bounded assembled JSON stands
  });

  it('strips parameterized and mixed-case data URLs (impl-Med-6)', () => {
    const out = JSON.stringify(
      stripMediaDeep({
        a: 'DATA:image/png;charset=utf-8;base64,' + 'Q'.repeat(4000),
      }),
    );
    expect(out).toContain('[media removed: 4000 bytes]');
    expect(out).not.toContain('QQQQ');
  });
});
