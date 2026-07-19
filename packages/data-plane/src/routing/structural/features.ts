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
  /** Declared reasoning demand in [0,1] (add-auto-hint-features), pre-mapped
   * from the request's declared controls — or null when NO control is present
   * (the presence bit: absent ≠ declared-`none`). */
  readonly reasoningDemand: number | null;
  /** Structured-output demand: an OpenAI json response_format or an Anthropic
   * `output_config.format` — folds into the schema sub-score at classify time. */
  readonly responseFormatDemand: boolean;
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

/** Declared-effort saturation: a thinking budget at/above this maps to exactly 1
 * (triggering the declared-maximal band rule). */
export const THINKING_SAT = 16_000;

/** Exact raw lowercase-literal effort mappings (add-auto-hint-features) — NO
 * input normalization: a case variant ("HIGH") is present-but-unrecognized and
 * scores the uniform conservative 0.5. Enum FIELD reads, never NL matching. */
export const OPENAI_EFFORT_DEMAND: Readonly<Record<string, number>> = {
  none: 0,
  minimal: 0.25,
  low: 0.5,
  medium: 0.75,
  high: 1,
  xhigh: 1,
  max: 1,
};
export const ANTHROPIC_EFFORT_DEMAND: Readonly<Record<string, number>> = {
  low: 0.5,
  medium: 0.75,
  high: 1,
  xhigh: 1,
  max: 1,
};

/** The uniform junk rule: any PRESENT-but-unrecognized value (wrong type,
 * unknown string, unknown thinking.type) scores 0.5 — declared-but-unknown. */
const DECLARED_UNKNOWN = 0.5;

function effortDemand(table: Readonly<Record<string, number>>, v: unknown): number {
  // OWN-property lookup (r3-Medium-1): `in` walks the prototype chain, so a
  // hostile "constructor"/"__proto__" string would resolve to an inherited
  // function and poison the score with NaN. Belt: the result must be finite.
  if (typeof v === 'string' && Object.hasOwn(table, v)) {
    const d = table[v];
    if (typeof d === 'number' && Number.isFinite(d)) return d;
  }
  return DECLARED_UNKNOWN;
}

/** Anthropic `thinking` control → demand. */
function thinkingDemand(thinking: unknown): number {
  if (typeof thinking !== 'object' || thinking === null) return DECLARED_UNKNOWN;
  const t = (thinking as Record<string, unknown>)['type'];
  if (t === 'disabled') return 0; // an explicit decline — steers low
  if (t === 'adaptive') return 0.5; // declared, model-managed depth
  if (t === 'enabled') {
    const budget = (thinking as Record<string, unknown>)['budget_tokens'];
    if (typeof budget === 'number' && Number.isFinite(budget) && budget > 0) {
      return Math.max(0.5, Math.min(1, budget / THINKING_SAT));
    }
    return 0.5; // enabled with no usable budget — declared, unquantified
  }
  return DECLARED_UNKNOWN;
}

/** Structural read of the opaque Anthropic output_config (never re-emitted from
 * here — passthrough stays in translate). A shapeless value contributes nothing. */
function outputConfigSignals(value: unknown): { effort: number | null; format: boolean } {
  if (typeof value !== 'object' || value === null) return { effort: null, format: false };
  const rec = value as Record<string, unknown>;
  const effort = 'effort' in rec ? effortDemand(ANTHROPIC_EFFORT_DEMAND, rec['effort']) : null;
  return { effort, format: rec['format'] !== undefined && rec['format'] !== null };
}

/** OpenAI response_format structural type read. */
function jsonResponseFormat(rf: unknown): boolean {
  if (typeof rf !== 'object' || rf === null) return false;
  const t = (rf as Record<string, unknown>)['type'];
  return t === 'json_schema' || t === 'json_object';
}

/** Declared reasoning demand across every present source (max), or null when
 * no source is present at all. */
function reasoningDemandOf(ir: NormalizedRequest): { demand: number | null; format: boolean } {
  const demands: number[] = [];
  if (ir.reasoning !== undefined) {
    demands.push(
      ir.reasoning.protocol === 'openai'
        ? effortDemand(OPENAI_EFFORT_DEMAND, ir.reasoning.effort)
        : thinkingDemand(ir.reasoning.thinking),
    );
  }
  let format = jsonResponseFormat(ir.responseFormat);
  if (ir.outputConfig !== undefined) {
    const oc = outputConfigSignals(ir.outputConfig.value);
    if (oc.effort !== null) demands.push(oc.effort);
    if (oc.format) format = true;
  }
  return { demand: demands.length > 0 ? Math.max(...demands) : null, format };
}

/** The request declared machine-parseable output (add-auto-hint-features reads,
 * shared with the cascade quality gate): an OpenAI json response_format, or a
 * non-null Anthropic `output_config.format`. */
export function declaredStructuredOutput(ir: NormalizedRequest): boolean {
  if (jsonResponseFormat(ir.responseFormat)) return true;
  return ir.outputConfig !== undefined && outputConfigSignals(ir.outputConfig.value).format;
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
  const declared = reasoningDemandOf(ir);
  return {
    effectiveInputChars: acc.chars,
    codeBlockChars: acc.code,
    toolCount: tools.length,
    toolSchemaDemand,
    multimodalPresent: acc.multimodal,
    conversationDepth: messages.length,
    maxOutputTokens:
      typeof maxOut === 'number' && Number.isFinite(maxOut) && maxOut > 0 ? maxOut : 0,
    reasoningDemand: declared.demand,
    responseFormatDemand: declared.format,
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
