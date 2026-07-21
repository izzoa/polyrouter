/**
 * The protocol-adapter contract. Each adapter (OpenAI, Anthropic) is a pure
 * transform between its wire shape and the `Normalized*` IR — no HTTP, no DB,
 * no config, no clock. Genuine provider deviations from the nominal protocol
 * are absorbed via `quirks`; the core stays protocol-agnostic.
 */
import type { NormalizedRequest, NormalizedResponse, NormalizedStreamEvent } from './ir';

/**
 * Genuine deviations from the nominal protocol (NOT nominal behavior such as
 * OpenAI's usage-in-final-empty-chunk, which the core handles). Defaults are
 * all "nominal"; #6 populates these per provider.
 */
export interface AdapterQuirks {
  /** Provider omits `usage` entirely — tolerate it (leave IR usage undefined). */
  readonly usageOmitted?: boolean;
  /** Provider already returns tool-call arguments as a parsed object, not a
   * JSON string — skip the parse step. */
  readonly toolArgumentsAlreadyObject?: boolean;
  /** Which spelling `requestOut` emits the output-token cap under — the value IS
   * the OpenAI wire field. `'max_completion_tokens'` (default; current OpenAI,
   * required by o-series/reasoning models) or `'max_tokens'` (legacy; for
   * OpenAI-compatible endpoints that only accept the old field). Exactly one is
   * ever emitted, never both; `requestIn` still accepts either. The sole quirk
   * that influences `requestOut`. */
  readonly maxTokensSpelling?: 'max_completion_tokens' | 'max_tokens';
}

/** Pure, caller-supplied context for fields a target protocol requires but the
 * source cannot provide (e.g. OpenAI `created`). No wall-clock reads occur in
 * this module; the proxy passes the request-time value it already holds. */
export interface SerializationContext {
  /** Unix seconds for OpenAI `created` when the IR lacks it. */
  readonly created?: number;
  /** Whether the client opted into the terminal usage chunk (OpenAI
   * `stream_options.include_usage`, A-7). When false/unset, the OpenAI stream
   * serializer omits the trailing `choices:[]` usage chunk — matching OpenAI, which
   * only sends it on opt-in. Anthropic ignores this (it always includes usage). */
  readonly includeUsage?: boolean;
}

/** Raised only for preconditions on OUR outbound serialization (e.g. a missing
 * Anthropic `max_tokens` with no default) — never for untrusted model output. */
export class SerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerializationError';
  }
}

/**
 * The UPSTREAM-ONLY half of protocol translation (add-chatgpt-responses): what the
 * provider HTTP adapter consumes — serialize the IR out, parse responses/streams in.
 * A protocol that exists only upstream (the OpenAI Responses wire — no client ever
 * speaks it to /v1) implements exactly this; the client-facing `ProtocolAdapter`
 * extends it, so the existing OpenAI/Anthropic modules satisfy it unchanged.
 */
export interface UpstreamProtocolAdapter {
  /** IR → wire request. */
  requestOut(ir: NormalizedRequest): unknown;
  /** Wire response → IR. */
  responseIn(wire: unknown): NormalizedResponse;
  /** Upstream SSE chunks → normalized event sequence. */
  streamParse(chunks: AsyncIterable<string>): AsyncGenerator<NormalizedStreamEvent>;
}

export interface ProtocolAdapter extends UpstreamProtocolAdapter {
  readonly protocol: 'openai' | 'anthropic';

  /** Wire request → IR. */
  requestIn(wire: unknown): NormalizedRequest;
  /** IR → wire response. */
  responseOut(ir: NormalizedResponse, ctx?: SerializationContext): unknown;
  /** Normalized event sequence → client SSE frame strings. */
  streamSerialize(
    events: AsyncIterable<NormalizedStreamEvent>,
    ctx?: SerializationContext,
  ): AsyncGenerator<string>;
}
