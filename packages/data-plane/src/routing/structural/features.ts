/**
 * Layer-1 structural feature extraction (#13, spec §7.2). Pure, language-neutral,
 * no I/O: given the normalized request, produce the structural signals the
 * classifier scores. De-contamination is by construction — the `system` block is
 * EXCLUDED from every feature (a huge harness preamble carries zero signal); the
 * scored window is the last `RECENT_WINDOW` messages ending at the final message,
 * so the latest turn is always measured even when it is a terminal tool result.
 * No natural-language keyword matching — every signal is a count/size/flag.
 */
import type { ContentBlock, NormalizedRequest } from '../../proxy/translate';

export interface StructuralFeatures {
  /** Text chars in the recent window (recursing into tool results); the size
   * signal, baseline-subtracted at classify time. */
  readonly effectiveInputChars: number;
  /** Chars inside fenced ``` spans in the window. */
  readonly codeBlockChars: number;
  /** Number of tool/function definitions on the request. */
  readonly toolCount: number;
  /** A tool carries a non-empty parameter schema (structured-output proxy). */
  readonly toolSchemaDemand: boolean;
  /** Any image content block in the window. */
  readonly multimodalPresent: boolean;
  /** Total message count. */
  readonly conversationDepth: number;
  /** Requested max output tokens (0 if unset). */
  readonly maxOutputTokens: number;
}

/** Recent-window size (messages) and scan/fingerprint caps (chars). The size
 * sub-score saturates at `SIZE_SAT` (< these caps), so the caps are lossless
 * while keeping the worst-case scan/hash sub-millisecond. */
export const RECENT_WINDOW = 6;
export const MAX_SCAN_CHARS = 32_000;
export const MAX_FINGERPRINT_CHARS = 16_000;

/** Sum the length of fenced ``` code spans in a string. */
function codeCharsIn(text: string): number {
  let total = 0;
  const re = /```[\s\S]*?```/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) total += m[0].length;
  return total;
}

interface ScanAcc {
  chars: number;
  code: number;
  multimodal: boolean;
  budget: number;
}

/** Walk content blocks, accumulating text size + code + multimodal, recursing
 * into tool-result content, and stopping once the scan budget is exhausted. */
function walk(blocks: readonly ContentBlock[], acc: ScanAcc): void {
  for (const b of blocks) {
    if (acc.budget <= 0) return;
    if (b.type === 'text') {
      const s = b.text.length <= acc.budget ? b.text : b.text.slice(0, acc.budget);
      acc.chars += s.length;
      acc.code += codeCharsIn(s);
      acc.budget -= s.length;
    } else if (b.type === 'image') {
      acc.multimodal = true;
    } else if (b.type === 'tool_result') {
      walk(b.content, acc);
    }
    // tool_use blocks contribute no text size (captured via toolCount/schema).
  }
}

export function extractStructuralFeatures(ir: NormalizedRequest): StructuralFeatures {
  const messages = ir.messages;
  const window =
    messages.length <= RECENT_WINDOW ? messages : messages.slice(messages.length - RECENT_WINDOW);
  const acc: ScanAcc = { chars: 0, code: 0, multimodal: false, budget: MAX_SCAN_CHARS };
  for (const msg of window) walk(msg.content, acc);

  const tools = ir.tools ?? [];
  const toolSchemaDemand = tools.some(
    (t) => t.parameters !== undefined && Object.keys(t.parameters).length > 0,
  );
  const maxOut = ir.params.maxOutputTokens;
  return {
    effectiveInputChars: acc.chars,
    codeBlockChars: acc.code,
    toolCount: tools.length,
    toolSchemaDemand,
    multimodalPresent: acc.multimodal,
    conversationDepth: messages.length,
    maxOutputTokens:
      typeof maxOut === 'number' && Number.isFinite(maxOut) && maxOut > 0 ? maxOut : 0,
  };
}

/** Canonicalize the `system` block into a stable, framing-sensitive string
 * (per-block type + length + content, delimited so `[A][B]` ≠ `[AB]`), capped at
 * `MAX_FINGERPRINT_CHARS`. Secret-free/pure: the control-plane store HMAC-keys
 * this into the baseline hash field (#13 design Decision 1). `''` when no system. */
export function canonicalizeSystem(ir: NormalizedRequest): string {
  const system = ir.system;
  if (system === undefined || system.length === 0) return '';
  let out = '';
  for (const b of system) {
    if (out.length >= MAX_FINGERPRINT_CHARS) break;
    out += b.type === 'text' ? `text:${b.text.length}${b.text}` : `${b.type}`;
  }
  return out.length > MAX_FINGERPRINT_CHARS ? out.slice(0, MAX_FINGERPRINT_CHARS) : out;
}
