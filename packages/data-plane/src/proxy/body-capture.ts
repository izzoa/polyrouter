/**
 * Body-capture primitives (add-body-capture) — pure, bounded, allocation-free
 * when disarmed. The stored request is the client-wire JSON with media parts
 * replaced by markers; the stored response is normalized ContentBlocks through
 * ONE canonical serializer, so buffered and streamed captures are
 * byte-identical for the same logical content. polyrouter's synthesized
 * terminal-error frame is never part of a capture (it is not model output).
 */
import type { ContentBlock, NormalizedStreamEvent, ToolUseBlock } from './translate/ir';

export interface CapturedText {
  readonly content: string;
  /** Post-strip, PRE-cap plaintext size — what the capture would have been. */
  readonly bytes: number;
  readonly truncated: boolean;
}

const MEDIA_MARKER = (n: number): string => `[media removed: ${String(n)} bytes]`;

/** A data URL with an inline base64 payload (OpenAI image_url shape) —
 * case-insensitive, parameters allowed (`data:image/png;charset=utf-8;base64,`;
 * clink impl-Med-6). */
const DATA_URL = /^data:[^,]*;base64,/i;

/** Deep-replace media payloads with size markers: base64 data URLs anywhere,
 * and Anthropic-style `{type:'base64', data}` source objects. One screenshot
 * must not dwarf a week of text (design D2). Pure; never throws on cycles the
 * JSON parser could not have produced. */
export function stripMediaDeep(v: unknown): unknown {
  if (typeof v === 'string') {
    if (DATA_URL.test(v)) return MEDIA_MARKER(v.length - v.indexOf(',') - 1);
    return v;
  }
  if (Array.isArray(v)) return v.map(stripMediaDeep);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) {
      // {type:'base64', data:'…'} (Anthropic image/document source)
      if (k === 'data' && typeof val === 'string' && o['type'] === 'base64') {
        out[k] = MEDIA_MARKER(val.length);
      } else {
        out[k] = stripMediaDeep(val);
      }
    }
    return out;
  }
  return v;
}

/** UTF-8-safe byte cap: cuts on a codepoint boundary, never mid-surrogate. */
function capUtf8(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= maxBytes) return { text: s, truncated: false };
  let text = buf.subarray(0, maxBytes).toString('utf8');
  // A cut continuation byte decodes to U+FFFD at the tail — drop it.
  while (text.endsWith('�')) text = text.slice(0, -1);
  return { text, truncated: true };
}

/** Client-wire request body → stored text (strip media, then cap). */
export function serializeClientRequest(raw: unknown, maxBytes: number): CapturedText {
  const json = JSON.stringify(stripMediaDeep(raw)) ?? 'null';
  const bytes = Buffer.byteLength(json, 'utf8');
  const capped = capUtf8(json, maxBytes);
  return { content: capped.text, bytes, truncated: capped.truncated };
}

/** THE canonical response serialization — both buffered and streamed captures
 * come through here (spec: identical information, no SSE framing). */
export function serializeResponseContent(
  blocks: readonly ContentBlock[],
  maxBytes: number,
): CapturedText {
  const json = JSON.stringify(blocks);
  const bytes = Buffer.byteLength(json, 'utf8');
  const capped = capUtf8(json, maxBytes);
  return { content: capped.text, bytes, truncated: capped.truncated };
}

interface TextSlot {
  readonly kind: 'text';
  parts: string[];
}
interface ToolSlot {
  readonly kind: 'tool';
  id: string;
  name: string;
  json: string[];
  /** Bytes charged against the budget for this slot (id+name+json) — refunded
   * when a finalized block replaces the assembled JSON. */
  charged: number;
  finalized?: ToolUseBlock;
}

/** Block-count ceiling — an upstream spamming indexes must not grow the slot
 * map unboundedly (clink impl-High-2). */
const MAX_BLOCKS = 128;

/**
 * Assembles normalized ContentBlocks from stream events under a byte budget
 * (invariant 12: STOPS retaining past the cap — the stream itself flows on).
 * `error` events are ignored by design (the terminal frame is not model
 * output). Only the COMMITTED attempt ever feeds a collector: pre-commit
 * failures error before their first content event, and the mid-stream commit
 * rule forbids a second committed stream — so one collector per request is
 * race-free across the fallback chain.
 */
export class BoundedBlockCollector {
  private readonly slots = new Map<number, TextSlot | ToolSlot>();
  private budget: number;
  private overflowed = false;

  constructor(private readonly maxBytes: number) {
    this.budget = maxBytes;
  }

  onEvent(ev: NormalizedStreamEvent): void {
    switch (ev.type) {
      case 'text_delta': {
        const slot = this.slot(ev.index, (): TextSlot => ({ kind: 'text', parts: [] }));
        if (slot?.kind === 'text') this.append(slot, slot.parts, ev.text);
        break;
      }
      case 'tool_use_start': {
        // Tool identity is retained content too — charged like any delta
        // (clink impl-High-2: provider-controlled ids/names must not ride free).
        const cost = Buffer.byteLength(ev.id, 'utf8') + Buffer.byteLength(ev.name, 'utf8');
        if (cost > this.budget) {
          this.overflowed = true;
          break;
        }
        const made = this.slot(
          ev.index,
          (): ToolSlot => ({ kind: 'tool', id: ev.id, name: ev.name, json: [], charged: cost }),
        );
        if (made?.kind === 'tool' && made.id === ev.id) this.budget -= cost;
        break;
      }
      case 'tool_use_delta': {
        const slot = this.slots.get(ev.index);
        if (slot?.kind === 'tool') this.append(slot, slot.json, ev.partialJson);
        break;
      }
      case 'block_stop': {
        const slot = this.slots.get(ev.index);
        if (slot?.kind === 'tool' && ev.finalizedToolUse) {
          // Refund the assembled charge, then charge the finalized block's real
          // serialized size — accepted only when it fits (an unrestricted
          // finalized input must not bypass the budget).
          const size = Buffer.byteLength(JSON.stringify(ev.finalizedToolUse), 'utf8');
          if (size <= this.budget + slot.charged) {
            this.budget = this.budget + slot.charged - size;
            slot.charged = size;
            slot.finalized = ev.finalizedToolUse;
          } else {
            this.overflowed = true; // keep the (already-bounded) assembled JSON
          }
        }
        break;
      }
      default:
        break; // message_* / error frames carry no capturable content
    }
  }

  /** True when the byte budget stopped retention at any point. */
  get truncated(): boolean {
    return this.overflowed;
  }

  /** True when anything at all was assembled (gates the response row). */
  get hasContent(): boolean {
    return this.slots.size > 0;
  }

  blocks(): ContentBlock[] {
    return [...this.slots.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, slot]) => {
        if (slot.kind === 'text') return { type: 'text', text: slot.parts.join('') };
        if (slot.finalized) return slot.finalized;
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(slot.json.join('')) as Record<string, unknown>;
        } catch {
          // partial tool JSON (truncated / aborted mid-block) — empty input;
          // the partial flag on the row carries the honesty.
        }
        return { type: 'tool_use', id: slot.id, name: slot.name, input };
      });
  }

  /** Returns null (and flags overflow) instead of creating a slot past the
   * block-count cap or an exhausted budget — the map itself is bounded. */
  private slot<T extends TextSlot | ToolSlot>(index: number, make: () => T): TextSlot | ToolSlot | null {
    const existing = this.slots.get(index);
    if (existing) return existing;
    if (this.slots.size >= MAX_BLOCKS || this.budget <= 0) {
      this.overflowed = true;
      return null;
    }
    const s = make();
    this.slots.set(index, s);
    return s;
  }

  private append(slot: TextSlot | ToolSlot, parts: string[], text: string): void {
    if (this.budget <= 0) {
      this.overflowed = true;
      return; // stop RETAINING — never stop the stream
    }
    const cost = Buffer.byteLength(text, 'utf8');
    if (cost > this.budget) {
      const capped = capUtf8(text, this.budget);
      parts.push(capped.text);
      if (slot.kind === 'tool') slot.charged += this.budget;
      this.budget = 0;
      this.overflowed = true;
      return;
    }
    parts.push(text);
    if (slot.kind === 'tool') slot.charged += cost;
    this.budget -= cost;
  }
}
