/**
 * The `Normalized*` intermediate representation (IR) — the single canonical,
 * protocol-agnostic shape for requests, responses, and streams (CLAUDE.md
 * invariant 2, spec §6.3). Provider adapters (#6) and the proxy (#10) consume
 * these types; nothing else defines a competing normalized shape.
 *
 * Design notes (see the change design.md):
 * - content-blocks-everywhere; `system` is a top-level request field.
 * - tool input is a PARSED object on success, or a raw string + parse-error
 *   flag on failure — translation never throws on model output.
 * - usage stores UNCACHED input components (Anthropic excludes cache tokens
 *   from input, OpenAI includes them); adapters convert by formula, not copy.
 * - a single assistant choice (`n = 1`) is normalized; `n > 1` is out of scope.
 */

export type Role = 'user' | 'assistant' | 'tool';

export type ImageDetail = 'auto' | 'low' | 'high';

/** Anthropic prompt-caching marker, carried opaquely (the translator never
 * interprets it). Present only on the Anthropic wire; dropped — documented —
 * crossing to OpenAI. Lives on text/tool_use/tool_result blocks, tools, and
 * system text blocks, never on images or nested tool-result content. */
export type CacheControl = { readonly type: 'ephemeral' } | Readonly<Record<string, unknown>>;

export interface TextBlock {
  readonly type: 'text';
  readonly text: string;
  readonly cacheControl?: CacheControl;
}

/** Base64-embedded image. `detail` is preserved through the IR but has no
 * Anthropic wire representation, so it is dropped crossing an Anthropic wire. */
export interface ImageDataBlock {
  readonly type: 'image';
  readonly data: string;
  readonly mediaType: string;
  readonly detail?: ImageDetail;
}

/** Remote image reference — never fetched here (SSRF is the proxy's concern). */
export interface ImageUrlBlock {
  readonly type: 'image';
  readonly url: string;
  readonly detail?: ImageDetail;
}

export type ImageBlock = ImageDataBlock | ImageUrlBlock;

/** A tool call with successfully-parsed arguments. */
export interface ToolUseOkBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly cacheControl?: CacheControl;
}

/** A tool call whose model-generated arguments were not valid JSON. OpenAI
 * documents this can happen; we carry the raw string rather than throw. */
export interface ToolUseRawBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly inputRaw: string;
  readonly inputParseError: true;
  readonly cacheControl?: CacheControl;
}

export type ToolUseBlock = ToolUseOkBlock | ToolUseRawBlock;

/** A tool result. Exactly one per `role:'tool'` message (clean 1:1 with an
 * OpenAI tool message); the Anthropic adapter groups/splits these at the wire. */
export interface ToolResultBlock {
  readonly type: 'tool_result';
  readonly toolUseId: string;
  readonly content: readonly ContentBlock[];
  readonly isError?: boolean;
  readonly cacheControl?: CacheControl;
}

export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

export interface NormalizedMessage {
  readonly role: Role;
  readonly content: readonly ContentBlock[];
}

/** JSON-Schema-ish tool parameter object; kept opaque to the translator. */
export type ToolParameters = Record<string, unknown>;

export interface NormalizedTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters: ToolParameters;
  readonly cacheControl?: CacheControl;
}

/** A reasoning/thinking control, tagged with its SOURCE protocol so `requestOut`
 * emits it only when serializing back to the owning protocol (same-protocol
 * passthrough) and drops it — documented — crossing to the other. */
export type ReasoningControl =
  | { readonly protocol: 'openai'; readonly effort: unknown }
  | { readonly protocol: 'anthropic'; readonly thinking: unknown };

export type NormalizedToolChoice = 'auto' | 'none' | 'required' | { readonly toolName: string };

export interface NormalizedParams {
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stopSequences?: readonly string[];
}

export interface NormalizedRequest {
  readonly model: string;
  readonly system?: readonly ContentBlock[];
  readonly messages: readonly NormalizedMessage[];
  readonly tools?: readonly NormalizedTool[];
  readonly toolChoice?: NormalizedToolChoice;
  /** Default true; maps to Anthropic `disable_parallel_tool_use = !this`. */
  readonly allowParallelTools?: boolean;
  readonly params: NormalizedParams;
  /** Structured-output control (OpenAI `response_format`), carried opaquely and
   * emitted only back to OpenAI. */
  readonly responseFormat?: unknown;
  /** Reasoning/thinking control, tagged with its source protocol (see {@link ReasoningControl}). */
  readonly reasoning?: ReasoningControl;
  /** Whether the client asked for a streamed response. */
  readonly stream?: boolean;
  /** Whether the client opted into a terminal usage chunk (OpenAI
   * `stream_options.include_usage`). The proxy always requests usage from the
   * upstream for cost accuracy, but only relays the terminal usage chunk to the
   * client when it asked (A-7); Anthropic always includes usage regardless. */
  readonly includeUsage?: boolean;
}

export type NormalizedStopReason =
  'stop' | 'length' | 'tool_use' | 'content_filter' | 'pause' | 'error' | 'other';

/**
 * Token usage in UNCACHED components. `inputTokens` is fresh (non-cached)
 * input; the documented identity is
 *   totalInput = inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0).
 * Missing usage is represented by `undefined` (the proxy flags
 * `usage_estimated`, #11), never a silent zero (spec §7.7, invariant 4).
 */
export interface NormalizedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

/** Every component optional — for streaming, where usage arrives piecemeal. */
export type PartialUsage = {
  readonly [K in keyof NormalizedUsage]?: NormalizedUsage[K];
};

export interface NormalizedResponse {
  readonly id: string;
  readonly model: string;
  /** OpenAI supplies this; Anthropic responses have none (optional). */
  readonly created?: number;
  readonly content: readonly ContentBlock[];
  readonly stopReason: NormalizedStopReason;
  /** The provider's original stop value, preserved for fidelity. */
  readonly rawStopReason?: string;
  /** Anthropic's matched stop sequence, when `stop_reason` was `stop_sequence`. */
  readonly stopSequence?: string;
  readonly usage?: NormalizedUsage;
}

/**
 * Streaming events. Usage may appear on `message_start` (Anthropic sends
 * input/cache up front) and/or `message_delta` (Anthropic output tokens;
 * OpenAI's terminal chunk carries the complete usage) — merged per component.
 * `block_stop` carries the finalized tool block so consumers get the parsed
 * (or parse-error) result without re-accumulating.
 */
export type NormalizedStreamEvent =
  | {
      readonly type: 'message_start';
      readonly id: string;
      readonly model: string;
      readonly role: 'assistant';
      readonly usage?: PartialUsage;
    }
  | { readonly type: 'text_delta'; readonly index: number; readonly text: string }
  | {
      readonly type: 'tool_use_start';
      readonly index: number;
      readonly id: string;
      readonly name: string;
    }
  | {
      readonly type: 'tool_use_delta';
      readonly index: number;
      readonly partialJson: string;
    }
  | {
      readonly type: 'block_stop';
      readonly index: number;
      readonly finalizedToolUse?: ToolUseBlock;
    }
  | {
      readonly type: 'message_delta';
      readonly stopReason?: NormalizedStopReason;
      readonly rawStopReason?: string;
      readonly stopSequence?: string;
      readonly usage?: PartialUsage;
    }
  | { readonly type: 'message_stop' }
  | {
      readonly type: 'error';
      readonly error: { readonly type: string; readonly message: string };
    };

export type Protocol = 'openai' | 'anthropic';
