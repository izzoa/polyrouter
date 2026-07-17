/**
 * Anthropic Messages ⟷ IR adapter. Pure transforms; no I/O.
 *
 * The crux is tool-result turn shape: Anthropic puts all `tool_result` blocks
 * at the start of one `user` message (optionally followed by text), while the
 * IR models each result as its own `role:'tool'` message. `requestOut` groups a
 * run of tool messages into one user message and appends an immediately-
 * following user message's blocks as trailing content; `requestIn` splits them
 * back out. Anthropic disallows consecutive same-role messages, so at most one
 * user message follows a tool run — the split/merge round-trips.
 */
import type { ProtocolAdapter, AdapterQuirks } from './adapter';
import { SerializationError } from './adapter';
import type {
  CacheControl,
  ContentBlock,
  NormalizedMessage,
  NormalizedRequest,
  NormalizedResponse,
  NormalizedStreamEvent,
  NormalizedToolChoice,
  TextBlock,
  ToolUseBlock,
} from './ir';
import type {
  AntContentBlock,
  AntMessage,
  AntRequest,
  AntResponse,
  AntStreamEvent,
  AntToolChoice,
} from './wire/anthropic';
import { stopReasonFromAnthropic, stopReasonToAnthropic } from './stop-reason';
import { partialUsageFromAnthropicStart, usageFromAnthropic, usageToAnthropic } from './usage';
import { formatSseEvent, sseFrames } from './stream';

export interface AnthropicAdapterOptions {
  /** Fallback for the required Anthropic `max_tokens` when the IR omits it. */
  readonly defaultMaxOutputTokens?: number;
}

function tryParseObject(s: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(s);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return {};
}

// --- IR block <-> Anthropic block ---

/** Anthropic prompt-caching marker passthrough (E2.4), carried opaquely. */
const ccOut = (c: CacheControl | undefined): { cache_control?: unknown } =>
  c !== undefined ? { cache_control: c } : {};
const ccIn = (c: unknown): { cacheControl?: CacheControl } =>
  c !== undefined ? { cacheControl: c as CacheControl } : {};

function irBlockToAnt(block: ContentBlock): AntContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text, ...ccOut(block.cacheControl) };
    case 'image':
      return 'url' in block
        ? { type: 'image', source: { type: 'url', url: block.url } }
        : {
            type: 'image',
            source: { type: 'base64', media_type: block.mediaType, data: block.data },
          };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: 'input' in block ? block.input : tryParseObject(block.inputRaw),
        ...ccOut(block.cacheControl),
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: toolResultContentToAnt(block.content),
        ...(block.isError === true ? { is_error: true } : {}),
        ...ccOut(block.cacheControl),
      };
  }
}

function toolResultContentToAnt(blocks: readonly ContentBlock[]): string | AntContentBlock[] {
  if (blocks.every((b) => b.type === 'text')) {
    return (blocks as TextBlock[]).map((b) => b.text).join('');
  }
  return blocks.map(irBlockToAnt);
}

function antBlockToIr(block: AntContentBlock): ContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text, ...ccIn(block.cache_control) };
    case 'image':
      return block.source.type === 'base64'
        ? { type: 'image', data: block.source.data, mediaType: block.source.media_type }
        : { type: 'image', url: block.source.url };
    case 'tool_use': {
      const input = block.input;
      if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: input as Record<string, unknown>,
          ...ccIn(block.cache_control),
        };
      }
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        inputRaw: JSON.stringify(input),
        inputParseError: true,
        ...ccIn(block.cache_control),
      };
    }
    case 'tool_result':
      // handled during message splitting; represent defensively as text
      return { type: 'text', text: '' };
  }
}

function antContentToBlocks(content: string | AntContentBlock[]): ContentBlock[] {
  if (typeof content === 'string') {
    return content === '' ? [] : [{ type: 'text', text: content }];
  }
  return content.map(antBlockToIr);
}

// --- tool choice ---

function toolChoiceIn(tc: AntToolChoice | undefined): {
  toolChoice?: NormalizedToolChoice;
  allowParallelTools?: boolean;
} {
  if (tc === undefined) return {};
  const allow = tc.disable_parallel_tool_use === true ? { allowParallelTools: false } : {};
  switch (tc.type) {
    case 'auto':
      return { toolChoice: 'auto', ...allow };
    case 'any':
      return { toolChoice: 'required', ...allow };
    case 'none':
      return { toolChoice: 'none', ...allow };
    case 'tool':
      return { toolChoice: { toolName: tc.name ?? '' }, ...allow };
  }
}

function toolChoiceOut(
  tc: NormalizedToolChoice | undefined,
  allowParallel: boolean | undefined,
): AntToolChoice | undefined {
  const disable = allowParallel === false ? { disable_parallel_tool_use: true } : {};
  if (tc === undefined) {
    return allowParallel === false ? { type: 'auto', ...disable } : undefined;
  }
  if (tc === 'auto') return { type: 'auto', ...disable };
  if (tc === 'none') return { type: 'none', ...disable };
  if (tc === 'required') return { type: 'any', ...disable };
  return { type: 'tool', name: tc.toolName, ...disable };
}

// --- request ---

function requestIn(wireInput: unknown): NormalizedRequest {
  const wire = wireInput as AntRequest;
  const messages: NormalizedMessage[] = [];

  for (const msg of wire.messages) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      // Split leading tool_result blocks into their own role:'tool' messages;
      // keep trailing (text/image) blocks as one following user message.
      const trailing: ContentBlock[] = [];
      for (const b of msg.content) {
        if (b.type === 'tool_result') {
          messages.push({
            role: 'tool',
            content: [
              {
                type: 'tool_result',
                toolUseId: b.tool_use_id,
                content: antContentToBlocks(b.content),
                ...(b.is_error === true ? { isError: true } : {}),
                ...ccIn(b.cache_control),
              },
            ],
          });
        } else {
          trailing.push(antBlockToIr(b));
        }
      }
      if (trailing.length > 0) messages.push({ role: 'user', content: trailing });
      continue;
    }
    messages.push({ role: msg.role, content: antContentToBlocks(msg.content) });
  }

  const system: ContentBlock[] | undefined =
    wire.system === undefined
      ? undefined
      : typeof wire.system === 'string'
        ? [{ type: 'text', text: wire.system }]
        : wire.system.map((b) => ({ type: 'text', text: b.text, ...ccIn(b.cache_control) }));

  const tools = wire.tools?.map((t) => ({
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    parameters: t.input_schema,
    ...ccIn(t.cache_control),
  }));

  const { toolChoice, allowParallelTools } = toolChoiceIn(wire.tool_choice);

  return {
    model: wire.model,
    ...(system !== undefined ? { system } : {}),
    messages,
    ...(tools !== undefined ? { tools } : {}),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(allowParallelTools !== undefined ? { allowParallelTools } : {}),
    params: {
      maxOutputTokens: wire.max_tokens,
      ...(wire.temperature !== undefined ? { temperature: wire.temperature } : {}),
      ...(wire.top_p !== undefined ? { topP: wire.top_p } : {}),
      ...(wire.stop_sequences !== undefined ? { stopSequences: wire.stop_sequences } : {}),
    },
    ...(wire.thinking !== undefined
      ? { reasoning: { protocol: 'anthropic' as const, thinking: wire.thinking } }
      : {}),
    ...(wire.stream !== undefined ? { stream: wire.stream } : {}),
  };
}

function requestOut(ir: NormalizedRequest, options: AnthropicAdapterOptions): AntRequest {
  const maxTokens = ir.params.maxOutputTokens ?? options.defaultMaxOutputTokens;
  if (maxTokens === undefined) {
    throw new SerializationError(
      'Anthropic requests require max_tokens; set NormalizedRequest.params.maxOutputTokens or the adapter defaultMaxOutputTokens.',
    );
  }

  const messages: AntMessage[] = [];
  const irMsgs = ir.messages;
  let i = 0;
  while (i < irMsgs.length) {
    const m = irMsgs[i];
    if (m === undefined) break;
    if (m.role === 'tool') {
      const content: AntContentBlock[] = [];
      while (i < irMsgs.length) {
        const tm = irMsgs[i];
        if (tm === undefined || tm.role !== 'tool') break;
        for (const b of tm.content) {
          if (b.type === 'tool_result') content.push(irBlockToAnt(b));
        }
        i += 1;
      }
      const next = irMsgs[i];
      if (next !== undefined && next.role === 'user') {
        for (const b of next.content) content.push(irBlockToAnt(b));
        i += 1;
      }
      messages.push({ role: 'user', content });
    } else if (m.role === 'user') {
      messages.push({ role: 'user', content: m.content.map(irBlockToAnt) });
      i += 1;
    } else {
      messages.push({ role: 'assistant', content: m.content.map(irBlockToAnt) });
      i += 1;
    }
  }

  const system = systemOut(ir.system);
  const tools = ir.tools?.map((t) => ({
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    input_schema: t.parameters,
    ...ccOut(t.cacheControl),
  }));
  const toolChoice = toolChoiceOut(ir.toolChoice, ir.allowParallelTools);

  return {
    model: ir.model,
    ...(system !== undefined ? { system } : {}),
    messages,
    max_tokens: maxTokens,
    ...(tools !== undefined ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    // OpenAI temperature is 0–2; Anthropic accepts 0–1 — clamp so a legal OpenAI
    // request routed here doesn't 400 (E2.9). Same-protocol input is in range.
    // (Extended thinking additionally requires temperature=1, but that is a
    // model-level constraint the proxy handles, not a protocol-level transform;
    // cross-protocol requests never carry `thinking`.)
    ...(ir.params.temperature !== undefined
      ? { temperature: Math.min(ir.params.temperature, 1) }
      : {}),
    ...(ir.params.topP !== undefined ? { top_p: ir.params.topP } : {}),
    ...(ir.params.stopSequences !== undefined
      ? { stop_sequences: [...ir.params.stopSequences] }
      : {}),
    // `thinking` is emitted only back to Anthropic (same-protocol); an OpenAI-tagged
    // reasoning control is a documented drop here (E2.5).
    ...(ir.reasoning?.protocol === 'anthropic' ? { thinking: ir.reasoning.thinking } : {}),
    ...(ir.stream !== undefined ? { stream: ir.stream } : {}),
  };
}

/** Serialize the IR system prompt without fusing blocks (E2.3): a text-block
 * array (carrying per-block `cache_control`) when there is more than one block or
 * any block has a marker; a plain string for a single unmarked text block
 * (canonically equivalent). Anthropic system supports only text, so any non-text
 * block (anomalous) is skipped rather than emitted as an empty block. */
function systemOut(
  system: NormalizedRequest['system'],
): string | { type: 'text'; text: string; cache_control?: unknown }[] | undefined {
  if (system === undefined || system.length === 0) return undefined;
  const texts = system.filter((b): b is TextBlock => b.type === 'text');
  if (texts.length === 0) return undefined;
  const hasMarker = texts.some((b) => b.cacheControl !== undefined);
  if (texts.length === 1 && !hasMarker) {
    return texts[0]!.text;
  }
  return texts.map((b) => ({
    type: 'text' as const,
    text: b.text,
    ...ccOut(b.cacheControl),
  }));
}

// --- response ---

function responseIn(wireInput: unknown, quirks: AdapterQuirks): NormalizedResponse {
  const wire = wireInput as AntResponse;
  const content: ContentBlock[] = wire.content.map(antBlockToIr);
  const usage = quirks.usageOmitted ? undefined : usageFromAnthropic(wire.usage);
  return {
    id: wire.id,
    model: wire.model,
    content,
    stopReason: stopReasonFromAnthropic(wire.stop_reason),
    ...(typeof wire.stop_reason === 'string' ? { rawStopReason: wire.stop_reason } : {}),
    ...(typeof wire.stop_sequence === 'string' ? { stopSequence: wire.stop_sequence } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
}

function responseOut(ir: NormalizedResponse): AntResponse {
  const content: AntContentBlock[] = [];
  for (const b of ir.content) {
    if (b.type === 'text' || b.type === 'tool_use' || b.type === 'image') {
      content.push(irBlockToAnt(b));
    }
  }
  return {
    id: ir.id,
    type: 'message',
    role: 'assistant',
    model: ir.model,
    content,
    stop_reason: stopReasonToAnthropic(ir.stopReason, ir.rawStopReason),
    stop_sequence: ir.stopSequence ?? null,
    ...(ir.usage !== undefined ? { usage: usageToAnthropic(ir.usage) } : {}),
  };
}

// --- streaming ---

interface AntOpenBlock {
  kind: 'text' | 'tool';
  id?: string;
  name?: string;
  json: string;
}

async function* streamParse(chunks: AsyncIterable<string>): AsyncGenerator<NormalizedStreamEvent> {
  const open = new Map<number, AntOpenBlock>();

  for await (const frame of sseFrames(chunks)) {
    let ev: AntStreamEvent;
    try {
      ev = JSON.parse(frame.data) as AntStreamEvent;
    } catch {
      continue;
    }
    switch (ev.type) {
      case 'message_start': {
        const usage = partialUsageFromAnthropicStart(ev.message.usage);
        yield {
          type: 'message_start',
          id: ev.message.id,
          model: ev.message.model,
          role: 'assistant',
          ...(Object.keys(usage).length > 0 ? { usage } : {}),
        };
        break;
      }
      case 'content_block_start': {
        if (ev.content_block.type === 'tool_use') {
          open.set(ev.index, {
            kind: 'tool',
            id: ev.content_block.id,
            name: ev.content_block.name,
            json: '',
          });
          yield {
            type: 'tool_use_start',
            index: ev.index,
            id: ev.content_block.id,
            name: ev.content_block.name,
          };
        } else {
          open.set(ev.index, { kind: 'text', json: '' });
        }
        break;
      }
      case 'content_block_delta': {
        if (ev.delta.type === 'text_delta') {
          yield { type: 'text_delta', index: ev.index, text: ev.delta.text };
        } else {
          const block = open.get(ev.index);
          if (block !== undefined) block.json += ev.delta.partial_json;
          yield { type: 'tool_use_delta', index: ev.index, partialJson: ev.delta.partial_json };
        }
        break;
      }
      case 'content_block_stop': {
        const block = open.get(ev.index);
        if (block !== undefined && block.kind === 'tool') {
          yield {
            type: 'block_stop',
            index: ev.index,
            finalizedToolUse: finalizeTool(block.id ?? '', block.name ?? '', block.json),
          };
        } else {
          yield { type: 'block_stop', index: ev.index };
        }
        open.delete(ev.index);
        break;
      }
      case 'message_delta': {
        const stopRaw = ev.delta.stop_reason;
        const outputTokens = ev.usage?.output_tokens;
        yield {
          type: 'message_delta',
          ...(stopRaw != null
            ? { stopReason: stopReasonFromAnthropic(stopRaw), rawStopReason: stopRaw }
            : {}),
          ...(ev.delta.stop_sequence != null ? { stopSequence: ev.delta.stop_sequence } : {}),
          ...(outputTokens !== undefined ? { usage: { outputTokens } } : {}),
        };
        break;
      }
      case 'message_stop':
        yield { type: 'message_stop' };
        break;
      case 'error':
        yield { type: 'error', error: ev.error };
        break;
      case 'ping':
        break;
    }
  }
}

function finalizeTool(id: string, name: string, json: string): ToolUseBlock {
  try {
    const parsed: unknown = JSON.parse(json === '' ? '{}' : json);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { type: 'tool_use', id, name, input: parsed as Record<string, unknown> };
    }
  } catch {
    // fall through
  }
  return { type: 'tool_use', id, name, inputRaw: json, inputParseError: true };
}

async function* streamSerialize(
  events: AsyncIterable<NormalizedStreamEvent>,
): AsyncGenerator<string> {
  const started = new Set<number>();

  for await (const ev of events) {
    switch (ev.type) {
      case 'message_start': {
        const usage = {
          input_tokens: ev.usage?.inputTokens ?? 0,
          output_tokens: ev.usage?.outputTokens ?? 0,
          ...(ev.usage?.cacheReadTokens !== undefined
            ? { cache_read_input_tokens: ev.usage.cacheReadTokens }
            : {}),
          ...(ev.usage?.cacheWriteTokens !== undefined
            ? { cache_creation_input_tokens: ev.usage.cacheWriteTokens }
            : {}),
        };
        yield formatSseEvent('message_start', {
          type: 'message_start',
          message: {
            id: ev.id,
            type: 'message',
            role: 'assistant',
            model: ev.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage,
          },
        });
        break;
      }
      case 'text_delta': {
        if (!started.has(ev.index)) {
          started.add(ev.index);
          yield formatSseEvent('content_block_start', {
            type: 'content_block_start',
            index: ev.index,
            content_block: { type: 'text', text: '' },
          });
        }
        yield formatSseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: ev.index,
          delta: { type: 'text_delta', text: ev.text },
        });
        break;
      }
      case 'tool_use_start': {
        started.add(ev.index);
        yield formatSseEvent('content_block_start', {
          type: 'content_block_start',
          index: ev.index,
          content_block: { type: 'tool_use', id: ev.id, name: ev.name, input: {} },
        });
        break;
      }
      case 'tool_use_delta': {
        yield formatSseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: ev.index,
          delta: { type: 'input_json_delta', partial_json: ev.partialJson },
        });
        break;
      }
      case 'block_stop': {
        yield formatSseEvent('content_block_stop', {
          type: 'content_block_stop',
          index: ev.index,
        });
        break;
      }
      case 'message_delta': {
        yield formatSseEvent('message_delta', {
          type: 'message_delta',
          delta: {
            stop_reason:
              ev.stopReason !== undefined
                ? stopReasonToAnthropic(ev.stopReason, ev.rawStopReason)
                : null,
            stop_sequence: ev.stopSequence ?? null,
          },
          ...(ev.usage?.outputTokens !== undefined
            ? { usage: { output_tokens: ev.usage.outputTokens } }
            : {}),
        });
        break;
      }
      case 'message_stop': {
        yield formatSseEvent('message_stop', { type: 'message_stop' });
        break;
      }
      case 'error': {
        yield formatSseEvent('error', { type: 'error', error: ev.error });
        break;
      }
    }
  }
}

export function createAnthropicAdapter(
  quirks: AdapterQuirks = {},
  options: AnthropicAdapterOptions = {},
): ProtocolAdapter {
  return {
    protocol: 'anthropic',
    requestIn,
    requestOut: (ir) => requestOut(ir, options),
    responseIn: (wire) => responseIn(wire, quirks),
    responseOut,
    streamParse,
    streamSerialize,
  };
}

export const anthropicAdapter = createAnthropicAdapter();
