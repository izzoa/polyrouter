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
  NormalizedStopReason,
  NormalizedStreamEvent,
  NormalizedToolChoice,
  PartialUsage,
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
import {
  mergePartialUsage,
  partialUsageFromAnthropicStart,
  usageFromAnthropic,
  usageToAnthropic,
} from './usage';
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

/** Wire block → IR block, or `null` for an unmodeled block type (`thinking`,
 * `server_tool_use`, …) which callers skip — never an `undefined` IR block that
 * crashes a later serialization (E2.8). */
function antBlockToIr(block: AntContentBlock): ContentBlock | null {
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
    default:
      return null; // unknown block type — skip
  }
}

function antContentToBlocks(content: string | AntContentBlock[]): ContentBlock[] {
  if (typeof content === 'string') {
    return content === '' ? [] : [{ type: 'text', text: content }];
  }
  return content.map(antBlockToIr).filter((b): b is ContentBlock => b !== null);
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
      // Normalize a user turn's blocks to the Anthropic contract: `tool_result`
      // blocks lead a user turn, so each becomes its own `role:'tool'` message (one
      // per result → 1:1 with an OpenAI tool message) and text/image become one
      // trailing `role:'user'` message. A non-conformant `[text, tool_result]` input
      // (Anthropic requires tool_result FIRST) is deliberately normalized to
      // `[tool_result, text]` — preserving the literal source order would emit invalid
      // consecutive user turns on the way back out (A-8: reviewed — this
      // reorder-to-conformant is correct, not the bug the audit read it as).
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
          const ir = antBlockToIr(b);
          if (ir !== null) trailing.push(ir);
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
    ...(wire.output_config !== undefined
      ? { outputConfig: { protocol: 'anthropic' as const, value: wire.output_config } }
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
    // `output_config` is same-protocol passthrough like `thinking`; the OpenAI
    // adapter drops it (documented — golden README dropped-field list).
    ...(ir.outputConfig?.protocol === 'anthropic' ? { output_config: ir.outputConfig.value } : {}),
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
  const content: ContentBlock[] = wire.content
    .map(antBlockToIr)
    .filter((b): b is ContentBlock => b !== null);
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
  // Keyed by the DENSE IR index. Unmodeled blocks (`thinking`, `server_tool_use`,
  // …) get NO IR index, so `remap` maps only recognized upstream indices to a
  // contiguous 0,1,2,… — otherwise skipping a block leaves a gap that makes
  // Anthropic SDKs append later content at the wrong position and drop it
  // (E2.8 + review finding 1).
  const open = new Map<number, AntOpenBlock>();
  const remap = new Map<number, number>();
  let nextIndex = 0;
  let sawMessageStop = false;
  let sawStopReason = false;

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
        // The wire union is a lie at runtime (providers ship `thinking` &c.), so
        // read the type as a string and skip anything unmodeled (no IR index).
        const cb = ev.content_block as { type: string; id?: string; name?: string };
        if (cb.type === 'tool_use') {
          const iri = nextIndex++;
          remap.set(ev.index, iri);
          open.set(iri, {
            kind: 'tool',
            ...(cb.id !== undefined ? { id: cb.id } : {}),
            ...(cb.name !== undefined ? { name: cb.name } : {}),
            json: '',
          });
          yield { type: 'tool_use_start', index: iri, id: cb.id ?? '', name: cb.name ?? '' };
        } else if (cb.type === 'text') {
          const iri = nextIndex++;
          remap.set(ev.index, iri);
          open.set(iri, { kind: 'text', json: '' });
        }
        // unknown block type → no remap entry; its deltas/stop resolve to
        // undefined below and are ignored.
        break;
      }
      case 'content_block_delta': {
        const iri = remap.get(ev.index);
        if (iri === undefined) break; // skipped/unknown block
        const d = ev.delta as { type: string; text?: string; partial_json?: string };
        if (d.type === 'text_delta') {
          yield { type: 'text_delta', index: iri, text: d.text ?? '' };
        } else if (d.type === 'input_json_delta') {
          const block = open.get(iri);
          if (block !== undefined) block.json += d.partial_json ?? '';
          yield { type: 'tool_use_delta', index: iri, partialJson: d.partial_json ?? '' };
        }
        // an unknown delta type (thinking_delta, signature_delta, …) is ignored
        break;
      }
      case 'content_block_stop': {
        const iri = remap.get(ev.index);
        if (iri === undefined) break; // skipped/unknown block
        const block = open.get(iri);
        if (block !== undefined && block.kind === 'tool') {
          yield {
            type: 'block_stop',
            index: iri,
            finalizedToolUse: finalizeTool(block.id ?? '', block.name ?? '', block.json),
          };
        } else {
          yield { type: 'block_stop', index: iri };
        }
        open.delete(iri);
        break;
      }
      case 'message_delta': {
        const stopRaw = ev.delta.stop_reason;
        const outputTokens = ev.usage?.output_tokens;
        if (stopRaw != null) sawStopReason = true;
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
        sawMessageStop = true;
        // A terminated-but-incomplete stream (message_stop with no stop reason
        // ever delivered) becomes an IR error — which core sees and records as
        // status=error — rather than a clean message_stop that reads as success
        // (review finding 2). E2.7 handles the no-message_stop case below.
        if (sawStopReason) {
          yield { type: 'message_stop' };
        } else {
          yield {
            type: 'error',
            error: { type: 'incomplete', message: 'stream ended without a stop reason' },
          };
        }
        break;
      case 'error':
        yield {
          type: 'error',
          error: ev.error,
          // Raw wire fields for the adapter-stage sanitizer; never serialized.
          diagnostic: { wire: { message: ev.error.message, type: ev.error.type } },
        };
        break;
      case 'ping':
        break;
    }
  }
  // Exhaustion without message_stop is a truncated stream — surface it as an
  // error, not a silent clean end that records status=success (E2.7/finding 2).
  if (!sawMessageStop) {
    yield {
      type: 'error',
      error: { type: 'truncated', message: 'upstream stream ended without a terminator' },
    };
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
  // Buffer the tail: Anthropic's wire carries a SINGLE message_delta (with the
  // final stop reason + output usage) immediately before message_stop. OpenAI
  // splits these across a finish chunk and a terminal usage-only chunk, so we
  // accumulate usage across all message_delta events and hold the stop info,
  // then emit one conformant message_delta at message_stop (E2.1) — never
  // null-clobbering a known stop reason, and always carrying usage.output_tokens
  // (a number Anthropic SDKs require).
  const tailUsage: PartialUsage[] = [];
  let stopReason: NormalizedStopReason | undefined;
  let rawStopReason: string | undefined;
  let stopSequence: string | undefined;

  const emitTail = (): string => {
    const merged = mergePartialUsage(...tailUsage);
    if (stopReason === undefined) {
      // A well-formed stream always carries a stop reason (and E2.7 turns a
      // truncated one into an `error` before message_stop). Reaching message_stop
      // with none is anomalous — surface it, don't fabricate `end_turn`.
      return formatSseEvent('error', {
        type: 'error',
        error: { type: 'incomplete', message: 'stream ended without a stop reason' },
      });
    }
    return formatSseEvent('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: stopReasonToAnthropic(stopReason, rawStopReason),
        stop_sequence: stopSequence ?? null,
      },
      usage: { output_tokens: merged.outputTokens ?? 0 },
    });
  };

  for await (const ev of events) {
    switch (ev.type) {
      case 'message_start': {
        if (ev.usage !== undefined) tailUsage.push(ev.usage);
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
        // Buffer, don't emit — the single conformant message_delta is flushed at
        // message_stop. Later usage merges in; a known stop reason is never lost.
        if (ev.usage !== undefined) tailUsage.push(ev.usage);
        if (ev.stopReason !== undefined) {
          stopReason = ev.stopReason;
          rawStopReason = ev.rawStopReason;
        }
        if (ev.stopSequence !== undefined) stopSequence = ev.stopSequence;
        break;
      }
      case 'message_stop': {
        yield emitTail();
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
