/**
 * Public surface of the protocol-translation module (CLAUDE.md invariant 2).
 * The `Normalized*` IR and the two adapters live here; nothing else in the
 * codebase re-exports a normalized shape. #6 (provider adapters) and #10 (the
 * proxy) consume this module; it performs no I/O.
 */
import type { Protocol } from './ir';
import type { ProtocolAdapter } from './adapter';
import { openaiAdapter, createOpenaiAdapter } from './openai';
import { anthropicAdapter, createAnthropicAdapter } from './anthropic';

export * from './ir';
export type { ProtocolAdapter, UpstreamProtocolAdapter, AdapterQuirks, SerializationContext } from './adapter';
export { SerializationError } from './adapter';
export { createOpenaiAdapter, openaiAdapter } from './openai';
export { createAnthropicAdapter, anthropicAdapter } from './anthropic';
export { createResponsesAdapter } from './responses';
export type { AnthropicAdapterOptions } from './anthropic';
export { canonRequest, canonResponse } from './canon';
export { sseFrames, formatSseData, formatSseEvent, fromChunks, collect } from './stream';
export { mergePartialUsage } from './usage';

/** The default (nominal, no-quirk) adapter for a protocol. */
export function getAdapter(protocol: Protocol): ProtocolAdapter {
  return protocol === 'openai' ? openaiAdapter : anthropicAdapter;
}

/** Construct an adapter with provider-specific quirks/options. */
export function createAdapter(
  protocol: Protocol,
  ...args: Parameters<typeof createOpenaiAdapter> | Parameters<typeof createAnthropicAdapter>
): ProtocolAdapter {
  return protocol === 'openai'
    ? createOpenaiAdapter(...(args as Parameters<typeof createOpenaiAdapter>))
    : createAnthropicAdapter(...(args as Parameters<typeof createAnthropicAdapter>));
}
