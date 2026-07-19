/**
 * OpenAI Responses upstream protocol (add-chatgpt-responses, §6.3 invariant 2).
 * UPSTREAM-ONLY: no client ever speaks this wire to /v1, so only requestOut /
 * responseIn / streamParse exist. Pure — no I/O, no clock; provider quirks stay in
 * the provider adapter.
 *
 * Contract highlights (golden-pinned; wire names verify-at-implementation):
 *  - `store: false` UNCONDITIONALLY — polyrouter never asks the backend to retain
 *    conversations (metadata-only ethos).
 *  - System prompt maps LOSSLESSLY: one block → `instructions` (a plain string on
 *    this wire); multi-block → leading developer-role `input` items, one per block
 *    (`instructions` unset) — the no-fusion rule holds unmodified.
 *  - Tool results correlate via the IR `toolUseId` ↔ wire `call_id` (never the
 *    output-item `id`).
 *  - Reasoning items (incl. `encrypted_content`) are DROPPED — never persisted or
 *    replayed (documented stateless/metadata-only trade).
 *  - Refusal content is represented as text (the IR's faithful shape — it has no
 *    refusal block); streamed `response.refusal.delta` assembles the same way.
 *  - Truncation honesty mirrors the OpenAI module: no clean `message_stop` without
 *    a semantic terminal event (a bare EOF must not launder a cut-off answer).
 */
import type {
  ContentBlock,
  NormalizedRequest,
  NormalizedResponse,
  NormalizedStopReason,
  NormalizedStreamEvent,
  NormalizedUsage,
  ToolUseBlock,
} from './ir';
import type { AdapterQuirks, UpstreamProtocolAdapter } from './adapter';
import { SerializationError } from './adapter';
import { sseFrames } from './stream';

// ---------- request out ----------

type Rec = Record<string, unknown>;

function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function imagePartOut(b: Extract<ContentBlock, { type: 'image' }>): Rec {
  return {
    type: 'input_image',
    image_url: 'url' in b ? b.url : `data:${b.mediaType};base64,${b.data}`,
    ...(b.detail !== undefined ? { detail: b.detail } : {}),
  };
}

function contentPartsOut(blocks: readonly ContentBlock[], role: 'user' | 'assistant'): Rec[] {
  const parts: Rec[] = [];
  for (const b of blocks) {
    if (b.type === 'text') {
      parts.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: b.text });
    } else if (b.type === 'image') {
      parts.push(imagePartOut(b));
    }
    // tool_use / tool_result blocks are serialized as their own input ITEMS, not
    // message content parts — handled in requestOut below.
  }
  return parts;
}

/** A tool result's `output`: the string form for text-only results (the common,
 * golden-stable case); the content-array form when the result carries images —
 * multimodal tool results are REPRESENTED, never silently text-flattened (r3). */
function toolOutputOut(blocks: readonly ContentBlock[]): string | Rec[] {
  if (!blocks.some((b) => b.type === 'image')) return textOf(blocks);
  const parts: Rec[] = [];
  for (const b of blocks) {
    if (b.type === 'text') parts.push({ type: 'input_text', text: b.text });
    else if (b.type === 'image') parts.push(imagePartOut(b));
  }
  return parts;
}

function toolUseItemOut(b: ToolUseBlock): Rec {
  return {
    type: 'function_call',
    call_id: b.id,
    name: b.name,
    arguments: 'inputRaw' in b ? b.inputRaw : JSON.stringify(b.input),
  };
}

function requestOut(ir: NormalizedRequest): unknown {
  const input: Rec[] = [];

  // System prompt: lossless. Single block → `instructions`; multi-block → leading
  // developer-role items, one PER BLOCK (boundaries preserved; no fusion).
  let instructions: string | undefined;
  const system = ir.system ?? [];
  const systemTexts = system.filter(
    (b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text',
  );
  if (systemTexts.length === 1) {
    instructions = systemTexts[0]!.text;
  } else if (systemTexts.length > 1) {
    for (const b of systemTexts) {
      input.push({
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: b.text }],
      });
    }
  }

  for (const m of ir.messages) {
    if (m.role === 'tool') {
      // Exactly one tool_result per tool message (IR contract) — correlate by call_id.
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          input.push({
            type: 'function_call_output',
            call_id: b.toolUseId,
            output: toolOutputOut(b.content),
          });
        }
      }
      continue;
    }
    const toolUses = m.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    const parts = contentPartsOut(m.content, m.role);
    if (parts.length > 0) {
      input.push({ type: 'message', role: m.role, content: parts });
    }
    // Assistant tool calls become their own function_call items (carrying call_id).
    for (const t of toolUses) input.push(toolUseItemOut(t));
  }

  const tools =
    ir.tools?.map((t) => ({
      type: 'function',
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      parameters: t.parameters,
    })) ?? undefined;

  let toolChoice: unknown;
  if (ir.toolChoice !== undefined) {
    toolChoice =
      typeof ir.toolChoice === 'string'
        ? ir.toolChoice
        : { type: 'function', name: ir.toolChoice.toolName };
  }

  // VERIFIED LIVE (2026-07-18, chatgpt.com/backend-api/codex/responses): the
  // backend REJECTS `max_output_tokens` and `temperature`/`top_p` outright
  // ("Unsupported parameter") — the IR's maxOutputTokens/sampling params are
  // documented DROPS on this wire, exactly like stopSequences. Token caps cannot
  // be enforced upstream on this backend.
  return {
    model: ir.model,
    ...(instructions !== undefined ? { instructions } : {}),
    input,
    ...(tools !== undefined ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(ir.allowParallelTools !== undefined ? { parallel_tool_calls: ir.allowParallelTools } : {}),
    store: false, // ALWAYS — never ask the backend to retain conversations
    stream: ir.stream === true,
  };
}

// ---------- response in ----------

function parseToolArguments(callId: string, name: string, raw: unknown): ToolUseBlock {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { type: 'tool_use', id: callId, name, input: parsed as Rec };
    }
  } catch {
    /* fall through to raw representation */
  }
  return { type: 'tool_use', id: callId, name, inputRaw: text, inputParseError: true };
}

function usageIn(raw: unknown): NormalizedUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const u = raw as Rec;
  const input = u['input_tokens'];
  const output = u['output_tokens'];
  if (typeof input !== 'number' || typeof output !== 'number') return undefined;
  const details = u['input_tokens_details'];
  const cached =
    typeof details === 'object' && details !== null ? (details as Rec)['cached_tokens'] : undefined;
  const cacheRead = typeof cached === 'number' && cached > 0 ? cached : undefined;
  // The IR stores UNCACHED input components (the documented identity).
  return {
    inputTokens: cacheRead !== undefined ? Math.max(0, input - cacheRead) : input,
    outputTokens: output,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
  };
}

interface TerminalInfo {
  readonly stopReason: NormalizedStopReason;
  readonly rawStopReason?: string;
}

function terminalFrom(
  status: unknown,
  incompleteReason: unknown,
  hasToolUse: boolean,
): TerminalInfo {
  if (status === 'incomplete') {
    if (incompleteReason === 'max_output_tokens') {
      return { stopReason: 'length', rawStopReason: 'max_output_tokens' };
    }
    if (incompleteReason === 'content_filter') {
      return { stopReason: 'content_filter', rawStopReason: 'content_filter' };
    }
    return {
      stopReason: 'other',
      ...(typeof incompleteReason === 'string' ? { rawStopReason: incompleteReason } : {}),
    };
  }
  return hasToolUse
    ? { stopReason: 'tool_use', rawStopReason: 'completed' }
    : { stopReason: 'stop', rawStopReason: 'completed' };
}

function contentIn(output: unknown): { blocks: ContentBlock[]; hasToolUse: boolean } {
  const blocks: ContentBlock[] = [];
  let hasToolUse = false;
  if (!Array.isArray(output)) return { blocks, hasToolUse };
  for (const item of output as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const it = item as Rec;
    if (it['type'] === 'message' && Array.isArray(it['content'])) {
      for (const part of it['content'] as unknown[]) {
        if (typeof part !== 'object' || part === null) continue;
        const p = part as Rec;
        // Refusal content is represented as TEXT — the IR's faithful shape.
        if (
          (p['type'] === 'output_text' || p['type'] === 'refusal') &&
          typeof (p['text'] ?? p['refusal']) === 'string'
        ) {
          const text = (p['type'] === 'refusal' ? p['refusal'] : p['text']) as string;
          blocks.push({ type: 'text', text });
        }
      }
    } else if (it['type'] === 'function_call') {
      const callId = typeof it['call_id'] === 'string' ? it['call_id'] : '';
      const name = typeof it['name'] === 'string' ? it['name'] : '';
      if (callId !== '' && name !== '') {
        blocks.push(parseToolArguments(callId, name, it['arguments']));
        hasToolUse = true;
      }
    }
    // reasoning items (incl. encrypted_content) and unknown item types: DROPPED.
  }
  return { blocks, hasToolUse };
}

function responseIn(wire: unknown): NormalizedResponse {
  if (typeof wire !== 'object' || wire === null) {
    throw new SerializationError('openai_responses: response is not an object');
  }
  const w = wire as Rec;
  const status = w['status'];
  if (status === 'failed') {
    // FIXED message — the upstream error body is untrusted (this backend is not a
    // documented contract and may echo request material, incl. the account id);
    // the classified failure class is all a caller needs (r3 finding 5).
    throw new SerializationError('openai_responses: upstream reported failure');
  }
  const incomplete =
    typeof w['incomplete_details'] === 'object' && w['incomplete_details'] !== null
      ? (w['incomplete_details'] as Rec)['reason']
      : undefined;
  const { blocks, hasToolUse } = contentIn(w['output']);
  const terminal = terminalFrom(status, incomplete, hasToolUse);
  const usage = usageIn(w['usage']);
  return {
    id: typeof w['id'] === 'string' ? w['id'] : 'resp',
    model: typeof w['model'] === 'string' ? w['model'] : '',
    content: blocks,
    stopReason: terminal.stopReason,
    ...(terminal.rawStopReason !== undefined ? { rawStopReason: terminal.rawStopReason } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
}

// ---------- streaming ----------

/** Only a conservative token-shaped error code passes through as the normalized
 * error `type` (it drives fallback/breaker classification); anything else — or an
 * upstream free-text message — is REPLACED, never forwarded (untrusted backend). */
const SAFE_ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
function safeErrorType(code: unknown): string {
  return typeof code === 'string' && SAFE_ERROR_CODE.test(code) ? code : 'server_error';
}

async function* streamParse(chunks: AsyncIterable<string>): AsyncGenerator<NormalizedStreamEvent> {
  // COMMIT RULE (invariant 3): this wire ACKNOWLEDGES with `response.created`
  // before producing anything, so `message_start` must NOT be emitted for it —
  // the proxy commits on the first non-error event, and a `created → failed`
  // acknowledgment-then-failure must stay fallback-eligible. The created metadata
  // is buffered and `message_start` is emitted lazily before the first real
  // output (or success terminal).
  let startMeta: { id: string; model: string } = { id: 'resp', model: '' };
  let started = false;
  let sawTerminal = false;
  let sawToolUse = false;
  // Assembly is keyed by the COMPOSITE `output_index:item_id` (the delta's rule —
  // official events carry both). An alias map keeps events that omit the index
  // for an already-seen item on the same key; an item-less event degrades to a
  // synthetic per-index key. Never a stringified object.
  const keyAlias = new Map<string, string>();
  const keyOf = (itemId: unknown, outputIndex: unknown): string => {
    const id = typeof itemId === 'string' && itemId !== '' ? itemId : undefined;
    const idx =
      typeof outputIndex === 'number' || typeof outputIndex === 'string'
        ? String(outputIndex)
        : undefined;
    if (id !== undefined) {
      const existing = keyAlias.get(id);
      if (existing !== undefined) return existing;
      const key = idx !== undefined ? `${idx}:${id}` : id;
      keyAlias.set(id, key);
      return key;
    }
    return `#${idx ?? '0'}`;
  };
  const indexByItem = new Map<string, number>();
  const toolMeta = new Map<string, { callId: string; name: string; args: string }>();
  let nextIndex = 0;

  const indexFor = (key: string): number => {
    const existing = indexByItem.get(key);
    if (existing !== undefined) return existing;
    const idx = nextIndex;
    nextIndex += 1;
    indexByItem.set(key, idx);
    return idx;
  };

  function startEvents(): NormalizedStreamEvent[] {
    if (started) return [];
    started = true;
    return [{ type: 'message_start', id: startMeta.id, model: startMeta.model, role: 'assistant' }];
  }

  for await (const frame of sseFrames(chunks)) {
    if (frame.data === '[DONE]') break;
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.data);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const ev = parsed as Rec;
    const type = ev['type'];

    if (type === 'response.created') {
      const resp = (ev['response'] ?? {}) as Rec;
      startMeta = {
        id: typeof resp['id'] === 'string' ? resp['id'] : 'resp',
        model: typeof resp['model'] === 'string' ? resp['model'] : '',
      };
      continue; // acknowledgment only — NOT output; no commit
    }

    if (type === 'response.output_item.added') {
      const item = (ev['item'] ?? {}) as Rec;
      if (item['type'] === 'function_call') {
        const key = keyOf(item['id'], ev['output_index']);
        const callId = typeof item['call_id'] === 'string' ? item['call_id'] : key;
        const name = typeof item['name'] === 'string' ? item['name'] : '';
        yield* startEvents();
        const index = indexFor(key);
        toolMeta.set(key, { callId, name, args: '' });
        sawToolUse = true;
        yield { type: 'tool_use_start', index, id: callId, name };
      }
      continue;
    }

    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      // Refusal deltas assemble exactly like text — the IR's refusal representation.
      const key = keyOf(ev['item_id'], ev['output_index']);
      const delta = typeof ev['delta'] === 'string' ? ev['delta'] : '';
      if (delta !== '') {
        yield* startEvents();
        yield { type: 'text_delta', index: indexFor(key), text: delta };
      }
      continue;
    }
    if (type === 'response.output_text.done' || type === 'response.refusal.done') {
      // `.done` carries the full text — deltas already emitted it; NEVER duplicate.
      continue;
    }

    if (type === 'response.function_call_arguments.delta') {
      const key = keyOf(ev['item_id'], ev['output_index']);
      const delta = typeof ev['delta'] === 'string' ? ev['delta'] : '';
      const meta = toolMeta.get(key);
      if (meta !== undefined && delta !== '') {
        meta.args += delta;
        yield { type: 'tool_use_delta', index: indexFor(key), partialJson: delta };
      }
      continue;
    }

    if (type === 'response.output_item.done') {
      const item = (ev['item'] ?? {}) as Rec;
      if (item['type'] === 'function_call') {
        const key = keyOf(item['id'], ev['output_index']);
        const meta = toolMeta.get(key);
        const callId =
          typeof item['call_id'] === 'string' ? item['call_id'] : (meta?.callId ?? key);
        const name = typeof item['name'] === 'string' ? item['name'] : (meta?.name ?? '');
        const args =
          typeof item['arguments'] === 'string' && item['arguments'] !== ''
            ? item['arguments']
            : (meta?.args ?? '');
        yield* startEvents();
        yield {
          type: 'block_stop',
          index: indexFor(key),
          finalizedToolUse: parseToolArguments(callId, name, args),
        };
      } else {
        const key = keyOf(item['id'], ev['output_index']);
        if (indexByItem.has(key)) yield { type: 'block_stop', index: indexFor(key) };
      }
      continue;
    }

    if (type === 'response.completed' || type === 'response.incomplete') {
      const resp = (ev['response'] ?? {}) as Rec;
      const incomplete =
        typeof resp['incomplete_details'] === 'object' && resp['incomplete_details'] !== null
          ? (resp['incomplete_details'] as Rec)['reason']
          : undefined;
      const terminal = terminalFrom(
        type === 'response.completed' ? 'completed' : 'incomplete',
        incomplete,
        sawToolUse,
      );
      const usage = usageIn(resp['usage']);
      sawTerminal = true;
      // A success terminal with zero output still yields a well-formed message.
      yield* startEvents();
      yield {
        type: 'message_delta',
        stopReason: terminal.stopReason,
        ...(terminal.rawStopReason !== undefined ? { rawStopReason: terminal.rawStopReason } : {}),
        ...(usage !== undefined ? { usage } : {}),
      };
      yield { type: 'message_stop' };
      continue;
    }

    if (type === 'response.failed' || type === 'error') {
      const errSrc = type === 'error' ? ev : (((ev['response'] ?? {}) as Rec)['error'] ?? {});
      const err = (typeof errSrc === 'object' && errSrc !== null ? errSrc : {}) as Rec;
      sawTerminal = true;
      // NO message_start here: pre-output failure must be the FIRST normalized
      // event so the proxy can still fall back (invariant 3). FIXED message —
      // upstream error text is untrusted and never forwarded (r3 finding 5);
      // the RAW wire fields ride the private diagnostic for the adapter-stage
      // sanitizer instead (add-request-error-detail) — never serialized.
      yield {
        type: 'error',
        error: { type: safeErrorType(err['code']), message: 'upstream stream error' },
        diagnostic: {
          wire: {
            ...(typeof err['message'] === 'string' ? { message: err['message'] } : {}),
            ...(typeof err['type'] === 'string' ? { type: err['type'] } : {}),
            ...(typeof err['code'] === 'string' ? { code: err['code'] } : {}),
          },
        },
      };
      continue;
    }
    // reasoning deltas/items and unknown response.* events: skipped (degradation rule).
  }
  // Truncation honesty (mirrors the OpenAI/Anthropic modules): exhaustion without a
  // semantic terminal surfaces as an error — never a silent clean end (r3 finding 2).
  if (!sawTerminal) {
    yield {
      type: 'error',
      error: { type: 'truncated', message: 'upstream stream ended without a terminator' },
    };
  }
}

/** Construct the upstream-only Responses adapter (quirks reserved for parity). */
export function createResponsesAdapter(_quirks: AdapterQuirks = {}): UpstreamProtocolAdapter {
  return {
    requestOut,
    responseIn,
    streamParse: (chunks) => streamParse(chunks),
  };
}
