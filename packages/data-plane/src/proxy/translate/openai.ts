/**
 * OpenAI Chat Completions ⟷ IR adapter. Pure transforms; no I/O. Malformed
 * tool-argument JSON is carried as a raw/parse-error block, never thrown.
 */
import type { ProtocolAdapter, AdapterQuirks, SerializationContext } from './adapter';
import type {
  ContentBlock,
  ImageBlock,
  NormalizedMessage,
  NormalizedRequest,
  NormalizedResponse,
  NormalizedStreamEvent,
  NormalizedTool,
  NormalizedToolChoice,
  PartialUsage,
  TextBlock,
  ToolUseBlock,
} from './ir';
import type {
  OaiChunk,
  OaiContentPart,
  OaiMessage,
  OaiRequest,
  OaiResponse,
  OaiToolCall,
  OaiToolChoice,
} from './wire/openai';
import { stopReasonFromOpenai, stopReasonToOpenai } from './stop-reason';
import { mergePartialUsage, partialUsageFromOpenai, usageFromOpenai, usageToOpenai } from './usage';
import { formatSseData, sseFrames } from './stream';

// --- shared block <-> part helpers ---

function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (m === null) return null;
  return { mediaType: m[1] as string, data: m[2] as string };
}

function parseToolArguments(name: string, id: string, args: string): ToolUseBlock {
  try {
    const parsed: unknown = JSON.parse(args);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { type: 'tool_use', id, name, input: parsed as Record<string, unknown> };
    }
  } catch {
    // fall through to raw
  }
  return { type: 'tool_use', id, name, inputRaw: args, inputParseError: true };
}

function toolArgumentsString(block: ToolUseBlock): string {
  return 'input' in block ? JSON.stringify(block.input) : block.inputRaw;
}

function partsToBlocks(parts: OaiContentPart[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url') {
      const { url, detail } = part.image_url;
      const data = parseDataUrl(url);
      if (data !== null) {
        blocks.push({
          type: 'image',
          data: data.data,
          mediaType: data.mediaType,
          ...(detail !== undefined ? { detail } : {}),
        });
      } else {
        blocks.push({
          type: 'image',
          url,
          ...(detail !== undefined ? { detail } : {}),
        });
      }
    }
  }
  return blocks;
}

function contentToBlocks(content: string | OaiContentPart[] | null | undefined): ContentBlock[] {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') {
    return content === '' ? [] : [{ type: 'text', text: content }];
  }
  return partsToBlocks(content);
}

function blockToPart(block: ContentBlock): OaiContentPart | null {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'image') {
    const url = 'url' in block ? block.url : `data:${block.mediaType};base64,${block.data}`;
    return {
      type: 'image_url',
      image_url: {
        url,
        ...(block.detail !== undefined ? { detail: block.detail } : {}),
      },
    };
  }
  return null; // tool_use / tool_result handled separately
}

/** A single text block → a string; more than one block (or any image) → a parts
 * array so adjacent text blocks are never fused into one string (E2.3); empty →
 * null. `canon` treats a string and a single-text-part array as equivalent, so
 * round-trip equivalence holds either way. */
function blocksToContent(blocks: readonly ContentBlock[]): string | OaiContentPart[] | null {
  const visual = blocks.filter(
    (b): b is TextBlock | ImageBlock => b.type === 'text' || b.type === 'image',
  );
  if (visual.length === 0) return null;
  const first = visual[0];
  if (visual.length === 1 && first !== undefined && first.type === 'text') {
    return first.text;
  }
  const parts: OaiContentPart[] = [];
  for (const b of visual) {
    const p = blockToPart(b);
    if (p !== null) parts.push(p);
  }
  return parts;
}

function toolResultText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** Response assistant content is text-only in OpenAI (`string | null`). */
function blocksToText(blocks: readonly ContentBlock[]): string | null {
  const texts = blocks.filter((b): b is TextBlock => b.type === 'text');
  return texts.length === 0 ? null : texts.map((b) => b.text).join('');
}

// --- tool choice ---

function toolChoiceIn(tc: OaiToolChoice | undefined): NormalizedToolChoice | undefined {
  if (tc === undefined) return undefined;
  if (tc === 'none' || tc === 'auto' || tc === 'required') return tc;
  return { toolName: tc.function.name };
}

function toolChoiceOut(tc: NormalizedToolChoice | undefined): OaiToolChoice | undefined {
  if (tc === undefined) return undefined;
  if (tc === 'none' || tc === 'auto' || tc === 'required') return tc;
  return { type: 'function', function: { name: tc.toolName } };
}

// --- request ---

function requestIn(wireInput: unknown, quirks: AdapterQuirks): NormalizedRequest {
  const wire = wireInput as OaiRequest;
  const systemBlocks: ContentBlock[] = [];
  const messages: NormalizedMessage[] = [];

  for (const msg of wire.messages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      for (const b of contentToBlocks(msg.content)) systemBlocks.push(b);
      continue;
    }
    if (msg.role === 'tool') {
      messages.push({
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            toolUseId: msg.tool_call_id ?? '',
            content: contentToBlocks(msg.content),
          },
        ],
      });
      continue;
    }
    if (msg.role === 'assistant') {
      const blocks: ContentBlock[] = contentToBlocks(msg.content);
      for (const tc of msg.tool_calls ?? []) {
        blocks.push(
          quirks.toolArgumentsAlreadyObject
            ? {
                type: 'tool_use',
                id: tc.id,
                name: tc.function.name,
                input: tc.function.arguments as unknown as Record<string, unknown>,
              }
            : parseToolArguments(tc.function.name, tc.id, tc.function.arguments),
        );
      }
      messages.push({ role: 'assistant', content: blocks });
      continue;
    }
    // user
    messages.push({ role: 'user', content: contentToBlocks(msg.content) });
  }

  const tools: NormalizedTool[] | undefined = wire.tools?.map((t) => ({
    name: t.function.name,
    ...(t.function.description !== undefined ? { description: t.function.description } : {}),
    parameters: t.function.parameters ?? {},
  }));

  const maxOut = wire.max_completion_tokens ?? wire.max_tokens;
  const stopSequences =
    wire.stop === undefined ? undefined : typeof wire.stop === 'string' ? [wire.stop] : wire.stop;
  const toolChoice = toolChoiceIn(wire.tool_choice);

  return {
    model: wire.model,
    ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
    messages,
    ...(tools !== undefined ? { tools } : {}),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(wire.parallel_tool_calls !== undefined
      ? { allowParallelTools: wire.parallel_tool_calls }
      : {}),
    params: {
      ...(maxOut !== undefined ? { maxOutputTokens: maxOut } : {}),
      ...(wire.temperature !== undefined ? { temperature: wire.temperature } : {}),
      ...(wire.top_p !== undefined ? { topP: wire.top_p } : {}),
      ...(stopSequences !== undefined ? { stopSequences } : {}),
    },
    ...(wire.response_format !== undefined ? { responseFormat: wire.response_format } : {}),
    ...(wire.reasoning_effort !== undefined
      ? { reasoning: { protocol: 'openai' as const, effort: wire.reasoning_effort } }
      : {}),
    ...(wire.stream !== undefined ? { stream: wire.stream } : {}),
    // Client presentation preference (A-7). NOTE: this is intentionally NOT
    // round-trip-stable — `requestOut` always forces `stream_options.include_usage`
    // upstream for cost accuracy (E2.2), so `requestIn(requestOut(ir))` reports
    // `includeUsage: true`. The proxy always serializes from the ORIGINAL client
    // request (`p.routed`), so the client-facing relay is gated correctly regardless.
    ...(wire.stream_options?.include_usage === true ? { includeUsage: true } : {}),
  };
}

function requestOut(ir: NormalizedRequest): OaiRequest {
  const messages: OaiMessage[] = [];
  if (ir.system !== undefined && ir.system.length > 0) {
    // A multi-block system prompt emits parts (no fusion, E2.3); a single block
    // stays a string. `?? ''` keeps a genuinely-empty system as an empty string.
    messages.push({ role: 'system', content: blocksToContent(ir.system) ?? '' });
  }
  for (const msg of ir.messages) {
    if (msg.role === 'tool') {
      const result = msg.content.find((b) => b.type === 'tool_result');
      const toolUseId =
        result !== undefined && result.type === 'tool_result' ? result.toolUseId : '';
      const content =
        result !== undefined && result.type === 'tool_result' ? toolResultText(result.content) : '';
      messages.push({ role: 'tool', tool_call_id: toolUseId, content });
      continue;
    }
    if (msg.role === 'assistant') {
      const toolCalls: OaiToolCall[] = [];
      for (const b of msg.content) {
        if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: toolArgumentsString(b) },
          });
        }
      }
      const content = blocksToContent(msg.content);
      messages.push({
        role: 'assistant',
        content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    messages.push({ role: 'user', content: blocksToContent(msg.content) });
  }

  const tools = ir.tools?.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      parameters: t.parameters,
    },
  }));
  const toolChoice = toolChoiceOut(ir.toolChoice);

  return {
    model: ir.model,
    messages,
    ...(tools !== undefined ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(ir.allowParallelTools !== undefined ? { parallel_tool_calls: ir.allowParallelTools } : {}),
    ...(ir.params.maxOutputTokens !== undefined
      ? { max_completion_tokens: ir.params.maxOutputTokens }
      : {}),
    ...(ir.params.temperature !== undefined ? { temperature: ir.params.temperature } : {}),
    ...(ir.params.topP !== undefined ? { top_p: ir.params.topP } : {}),
    ...(ir.params.stopSequences !== undefined ? { stop: [...ir.params.stopSequences] } : {}),
    ...(ir.responseFormat !== undefined ? { response_format: ir.responseFormat } : {}),
    // Reasoning is emitted only back to OpenAI (same-protocol); an Anthropic-tagged
    // control is a documented drop here (E2.5).
    ...(ir.reasoning?.protocol === 'openai' ? { reasoning_effort: ir.reasoning.effort } : {}),
    ...(ir.stream !== undefined ? { stream: ir.stream } : {}),
    // Ask OpenAI-compatible upstreams for the terminal usage chunk so streamed
    // cost is exact, not chars/4-estimated (E2.2). `canon` drops stream_options.
    ...(ir.stream === true ? { stream_options: { include_usage: true } } : {}),
  };
}

// --- response ---

function responseIn(wireInput: unknown, quirks: AdapterQuirks): NormalizedResponse {
  const wire = wireInput as OaiResponse;
  const choice = wire.choices[0];
  const blocks: ContentBlock[] = [];
  if (choice !== undefined) {
    for (const b of contentToBlocks(choice.message.content)) blocks.push(b);
    for (const tc of choice.message.tool_calls ?? []) {
      blocks.push(
        quirks.toolArgumentsAlreadyObject
          ? {
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: tc.function.arguments as unknown as Record<string, unknown>,
            }
          : parseToolArguments(tc.function.name, tc.id, tc.function.arguments),
      );
    }
  }
  const finish = choice?.finish_reason;
  const usage = quirks.usageOmitted ? undefined : usageFromOpenai(wire.usage);
  return {
    id: wire.id,
    model: wire.model,
    created: wire.created,
    content: blocks,
    stopReason: stopReasonFromOpenai(finish),
    ...(typeof finish === 'string' ? { rawStopReason: finish } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
}

function responseOut(ir: NormalizedResponse, ctx: SerializationContext | undefined): OaiResponse {
  const toolCalls: OaiToolCall[] = [];
  for (const b of ir.content) {
    if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: toolArgumentsString(b) },
      });
    }
  }
  const content = blocksToText(ir.content);
  const created = ir.created ?? ctx?.created ?? 0;
  return {
    id: ir.id,
    object: 'chat.completion',
    created,
    model: ir.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: stopReasonToOpenai(ir.stopReason, ir.rawStopReason),
      },
    ],
    ...(ir.usage !== undefined ? { usage: usageToOpenai(ir.usage) } : {}),
  };
}

// --- streaming ---

interface OpenBlock {
  kind: 'text' | 'tool';
  id?: string;
  name?: string;
  json: string;
  /** Whether `tool_use_start` was already emitted for this tool block (A-6) — a
   * provider that repeats `id`/`name` on later argument fragments must not re-open. */
  started?: boolean;
}

async function* streamParse(
  chunks: AsyncIterable<string>,
  _quirks: AdapterQuirks,
): AsyncGenerator<NormalizedStreamEvent> {
  const blockIndex = new Map<string, number>();
  const open = new Map<number, OpenBlock>();
  let started = false;
  // Whether a finish_reason (the semantic terminator) was seen. `[DONE]` alone is
  // SSE housekeeping — a stream that ends with `[DONE]` but no finish_reason (or
  // just exhausts) is truncated and must NOT get a clean message_stop, which
  // would launder a cut-off answer into status=success (E2.7).
  let sawFinish = false;

  const alloc = (key: string): number => {
    const existing = blockIndex.get(key);
    if (existing !== undefined) return existing;
    const idx = blockIndex.size;
    blockIndex.set(key, idx);
    return idx;
  };

  for await (const frame of sseFrames(chunks)) {
    if (frame.data === '[DONE]') break; // loop terminator only — not a stop reason
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.data);
    } catch {
      continue;
    }
    // An in-band error frame (`{ error: … }`, no usable `choices`) must be
    // recognized BEFORE reading `choices`, else it TypeErrors (E2.8/finding 5).
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { error?: unknown }).error != null &&
      (parsed as { choices?: unknown }).choices === undefined
    ) {
      const err = (parsed as { error: { type?: unknown; message?: unknown } }).error;
      yield {
        type: 'error',
        error: {
          type: typeof err.type === 'string' ? err.type : 'server_error',
          message: typeof err.message === 'string' ? err.message : 'upstream stream error',
        },
      };
      continue;
    }
    const chunk = parsed as OaiChunk;
    if (!Array.isArray(chunk.choices)) continue; // malformed frame — skip, don't throw

    if (!started) {
      started = true;
      yield { type: 'message_start', id: chunk.id, model: chunk.model, role: 'assistant' };
    }

    // Terminal usage chunk (choices: []).
    if (chunk.choices.length === 0) {
      if (chunk.usage != null) {
        yield { type: 'message_delta', usage: partialUsageFromOpenai(chunk.usage) };
      }
      continue;
    }

    const choice = chunk.choices[0];
    if (choice === undefined) continue;
    const delta = choice.delta;

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      const idx = alloc('text');
      if (!open.has(idx)) open.set(idx, { kind: 'text', json: '' });
      yield { type: 'text_delta', index: idx, text: delta.content };
    }

    for (const tc of delta.tool_calls ?? []) {
      const idx = alloc(`tool:${tc.index}`);
      let block = open.get(idx);
      if (block === undefined) {
        block = { kind: 'tool', json: '' };
        open.set(idx, block);
      }
      if (tc.id !== undefined) block.id = tc.id;
      if (tc.function?.name !== undefined) block.name = tc.function.name;
      // Emit `tool_use_start` exactly once per block (A-6): the first fragment that
      // carries an id/name opens it; a provider that repeats id/name on subsequent
      // argument fragments updates the block but must not re-open it.
      if (!block.started && (block.id !== undefined || block.name !== undefined)) {
        block.started = true;
        yield {
          type: 'tool_use_start',
          index: idx,
          id: block.id ?? '',
          name: block.name ?? '',
        };
      }
      const argFragment = tc.function?.arguments;
      if (argFragment !== undefined && argFragment.length > 0) {
        block.json += argFragment;
        yield { type: 'tool_use_delta', index: idx, partialJson: argFragment };
      }
    }

    if (choice.finish_reason != null) {
      sawFinish = true;
      for (const [idx, block] of [...open.entries()].sort((a, b) => a[0] - b[0])) {
        if (block.kind === 'tool') {
          yield {
            type: 'block_stop',
            index: idx,
            finalizedToolUse: parseToolArguments(block.name ?? '', block.id ?? '', block.json),
          };
        } else {
          yield { type: 'block_stop', index: idx };
        }
      }
      open.clear();
      yield {
        type: 'message_delta',
        stopReason: stopReasonFromOpenai(choice.finish_reason),
        rawStopReason: choice.finish_reason,
      };
    }
  }

  if (sawFinish) {
    yield { type: 'message_stop' };
  } else {
    yield {
      type: 'error',
      error: { type: 'truncated', message: 'upstream stream ended without a terminator' },
    };
  }
}

async function* streamSerialize(
  events: AsyncIterable<NormalizedStreamEvent>,
  ctx: SerializationContext | undefined,
): AsyncGenerator<string> {
  let id = 'chatcmpl-stream';
  let model = '';
  const created = ctx?.created ?? 0;
  const toolIndexByBlock = new Map<number, number>();
  let nextToolIndex = 0;
  let pendingUsage: PartialUsage | undefined;

  const chunk = (choices: unknown[]): string =>
    formatSseData({ id, object: 'chat.completion.chunk', created, model, choices });

  for await (const ev of events) {
    switch (ev.type) {
      case 'message_start': {
        id = ev.id;
        model = ev.model;
        if (ev.usage !== undefined) pendingUsage = mergePartialUsage(pendingUsage, ev.usage);
        yield chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);
        break;
      }
      case 'text_delta': {
        yield chunk([{ index: 0, delta: { content: ev.text }, finish_reason: null }]);
        break;
      }
      case 'tool_use_start': {
        const ti = nextToolIndex++;
        toolIndexByBlock.set(ev.index, ti);
        yield chunk([
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: ti,
                  id: ev.id,
                  type: 'function',
                  function: { name: ev.name, arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ]);
        break;
      }
      case 'tool_use_delta': {
        const ti = toolIndexByBlock.get(ev.index) ?? 0;
        yield chunk([
          {
            index: 0,
            delta: { tool_calls: [{ index: ti, function: { arguments: ev.partialJson } }] },
            finish_reason: null,
          },
        ]);
        break;
      }
      case 'block_stop':
        break;
      case 'message_delta': {
        if (ev.usage !== undefined) pendingUsage = mergePartialUsage(pendingUsage, ev.usage);
        if (ev.stopReason !== undefined) {
          yield chunk([
            {
              index: 0,
              delta: {},
              finish_reason: stopReasonToOpenai(ev.stopReason, ev.rawStopReason),
            },
          ]);
        }
        break;
      }
      case 'message_stop': {
        // Only relay the terminal usage chunk when the client opted in (A-7) — the
        // proxy always requests usage upstream for cost, but OpenAI itself omits the
        // `choices:[]` usage chunk unless `stream_options.include_usage` was set.
        if (pendingUsage !== undefined && ctx?.includeUsage === true) {
          const norm = usagePartialToWire(pendingUsage);
          if (norm !== undefined) {
            yield formatSseData({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [],
              usage: norm,
            });
          }
        }
        yield 'data: [DONE]\n\n';
        break;
      }
      case 'error':
        break;
    }
  }
}

function usagePartialToWire(p: PartialUsage): ReturnType<typeof usageToOpenai> | undefined {
  if (p.inputTokens === undefined || p.outputTokens === undefined) return undefined;
  return usageToOpenai({
    inputTokens: p.inputTokens,
    outputTokens: p.outputTokens,
    ...(p.cacheReadTokens !== undefined ? { cacheReadTokens: p.cacheReadTokens } : {}),
    ...(p.cacheWriteTokens !== undefined ? { cacheWriteTokens: p.cacheWriteTokens } : {}),
  });
}

export function createOpenaiAdapter(quirks: AdapterQuirks = {}): ProtocolAdapter {
  return {
    protocol: 'openai',
    requestIn: (wire) => requestIn(wire, quirks),
    requestOut,
    responseIn: (wire) => responseIn(wire, quirks),
    responseOut,
    streamParse: (chunks) => streamParse(chunks, quirks),
    streamSerialize,
  };
}

export const openaiAdapter = createOpenaiAdapter();
