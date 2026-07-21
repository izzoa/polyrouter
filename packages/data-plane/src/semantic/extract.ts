import type { ContentBlock, NormalizedMessage, NormalizedRequest } from '../proxy/translate/ir';

/**
 * Canonical semantic-input extractor v1 (add-semantic-routing D3). Layer 1's
 * feature extractor emits NUMBERS; this is the one real text serialization
 * Layer 2 embeds — and both downstream truncations (the embedder's char cap,
 * WordPiece's token cap) keep PREFIXES, so the serialization is NEWEST-FIRST:
 * the newest user turn leads and is granted the WHOLE budget (head-kept when
 * it alone exceeds it), then prior non-system messages newest-first. System
 * content is EXCLUDED entirely. The version is part of the classifier revision
 * stamp — any change to this algorithm is a new embedding space.
 *
 * Budget-aware and bounded (clink r2 Med-2): rendering stops the moment the
 * total budget is spent, blocks and messages are traversed under hard caps
 * (a 10 MB request never forces a full map/join), and a request with NO
 * non-system evidence renders `''` — the router treats that as `skip`.
 */
export const SEMANTIC_EXTRACTOR_VERSION = 1;

export interface ExtractCaps {
  /** Total output cap — set to the embedder's input cap so downstream char
   * truncation is a no-op backstop. The NEWEST turn may use all of it. */
  readonly totalChars: number;
  /** Per-PRIOR-message cap (the newest turn is capped only by totalChars). */
  readonly perMessageChars?: number;
  /** Per-block text cap. */
  readonly perBlockChars?: number;
  /** Bounded traversal: at most this many messages are serialized. */
  readonly maxMessages?: number;
  /** Bounded traversal: at most this many blocks scanned per message. */
  readonly maxBlocksPerMessage?: number;
}

const DEFAULT_PER_MESSAGE = 600;
const DEFAULT_PER_BLOCK = 400;
const DEFAULT_MAX_MESSAGES = 8;
const DEFAULT_MAX_BLOCKS = 32;

export function extractSemanticInput(ir: NormalizedRequest, caps: ExtractCaps): string {
  const perPriorMessage = caps.perMessageChars ?? DEFAULT_PER_MESSAGE;
  const perBlock = caps.perBlockChars ?? DEFAULT_PER_BLOCK;
  const maxMessages = caps.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxBlocks = caps.maxBlocksPerMessage ?? DEFAULT_MAX_BLOCKS;

  const messages = ir.messages;
  let newestUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      newestUserIdx = i;
      break;
    }
  }

  const parts: string[] = [];
  let used = 0;
  const budgetLeft = (): number => caps.totalChars - used;
  const push = (text: string): boolean => {
    if (text.length === 0) return true;
    const remaining = budgetLeft();
    if (remaining <= 0) return false;
    const slice = text.length > remaining ? text.slice(0, remaining) : text;
    parts.push(slice);
    used += slice.length + 1; // +1 for the join newline
    return slice.length === text.length;
  };

  // The newest user turn leads — granted the WHOLE budget (head-kept if it
  // alone exceeds it), not the smaller per-prior-message cap.
  if (newestUserIdx >= 0) {
    push(renderMessage(messages[newestUserIdx]!, caps.totalChars, perBlock, maxBlocks));
  }
  // Prior context, newest-first, bounded by count AND remaining budget.
  let taken = newestUserIdx >= 0 ? 1 : 0;
  for (let i = messages.length - 1; i >= 0 && taken < maxMessages; i -= 1) {
    if (i === newestUserIdx) continue;
    if (budgetLeft() <= 0) break;
    const msg = messages[i];
    if (msg === undefined) continue;
    if (!push(renderMessage(msg, perPriorMessage, perBlock, maxBlocks))) break;
    taken += 1;
  }
  return parts.join('\n');
}

function renderMessage(
  msg: NormalizedMessage,
  perMessage: number,
  perBlock: number,
  maxBlocks: number,
): string {
  const role = msg.role === 'tool' ? 'tool' : msg.role;
  const rendered: string[] = [];
  let acc = `${role}: `.length;
  // A single top-level block may fill this message's whole budget (so the
  // newest turn's lone big text block isn't clipped to the small per-block
  // cap); the per-block cap still bounds NESTED tool-result content.
  const blockCap = Math.max(perBlock, perMessage);
  // Bounded scan: at most `maxBlocks` blocks, and stop once this message's
  // own cap is reached (never map/join an unbounded block collection).
  for (let b = 0; b < msg.content.length && b < maxBlocks; b += 1) {
    if (acc >= perMessage) break;
    const text = renderBlock(msg.content[b]!, blockCap, perBlock);
    if (text.length === 0) continue;
    rendered.push(text);
    acc += text.length + 1;
  }
  // No renderable content → contribute NOTHING (no bare `role:` framing), so
  // a request with no non-system evidence extracts to '' and the router skips.
  if (rendered.length === 0) return '';
  const line = `${role}: ${rendered.join(' ')}`;
  return line.length > perMessage ? line.slice(0, perMessage) : line;
}

/** `cap` bounds this block's text; `nestedCap` bounds nested tool-result text. */
function renderBlock(block: ContentBlock, cap: number, nestedCap: number): string {
  switch (block.type) {
    case 'text':
      return block.text.length > cap ? block.text.slice(0, cap) : block.text;
    case 'image':
      return '[image]';
    case 'tool_use':
      return `[tool call ${block.name}]`;
    case 'tool_result': {
      // Depth-1 recursion, bounded: nested text only; anything deeper or
      // non-text becomes its marker. Block count bounded to avoid unbounded
      // traversal of a huge tool result.
      const inner: string[] = [];
      for (let i = 0; i < block.content.length && i < 16; i += 1) {
        const b = block.content[i]!;
        inner.push(
          b.type === 'text'
            ? b.text.length > nestedCap
              ? b.text.slice(0, nestedCap)
              : b.text
            : b.type === 'image'
              ? '[image]'
              : b.type === 'tool_use'
                ? `[tool call ${b.name}]`
                : '[tool result]',
        );
      }
      const joined = inner.join(' ');
      const capped = joined.length > nestedCap ? joined.slice(0, nestedCap) : joined;
      return `[tool result] ${capped}`.trim();
    }
  }
}
