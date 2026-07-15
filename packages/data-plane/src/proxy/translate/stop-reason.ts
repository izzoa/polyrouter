/**
 * Stop-reason mapping. Canonical values plus a raw passthrough so nothing is
 * lost: `rawStopReason` always holds the provider's original value, and
 * `stopSequence` holds Anthropic's matched sequence. `refusal` → content_filter;
 * `pause_turn` → the distinct `pause` (continuation-required); unknown → other.
 */
import type { NormalizedStopReason } from './ir';

export function stopReasonFromOpenai(
  finishReason: string | null | undefined,
): NormalizedStopReason {
  switch (finishReason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call': // legacy
      return 'tool_use';
    case 'content_filter':
      return 'content_filter';
    case null:
    case undefined:
      return 'other';
    default:
      return 'other';
  }
}

export function stopReasonFromAnthropic(
  stopReason: string | null | undefined,
): NormalizedStopReason {
  switch (stopReason) {
    case 'end_turn':
      return 'stop';
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'tool_use';
    case 'refusal':
      return 'content_filter';
    case 'pause_turn':
      return 'pause';
    case null:
    case undefined:
      return 'other';
    default:
      return 'other';
  }
}

/** Canonical → OpenAI `finish_reason`. When the source was OpenAI, `raw`
 * restores the exact original value for same-protocol fidelity. */
export function stopReasonToOpenai(reason: NormalizedStopReason, raw?: string): string | null {
  const known = new Set(['stop', 'length', 'tool_calls', 'function_call', 'content_filter']);
  if (raw !== undefined && known.has(raw)) return raw;
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    case 'pause': // no OpenAI equivalent
      return 'stop';
    case 'error':
      return null;
    case 'other':
      return 'stop';
    default:
      return 'stop';
  }
}

/** Canonical → Anthropic `stop_reason`. When the source was Anthropic, `raw`
 * restores the exact original value for same-protocol fidelity. */
export function stopReasonToAnthropic(reason: NormalizedStopReason, raw?: string): string | null {
  const known = new Set([
    'end_turn',
    'stop_sequence',
    'max_tokens',
    'tool_use',
    'refusal',
    'pause_turn',
    'model_context_window_exceeded',
  ]);
  if (raw !== undefined && known.has(raw)) return raw;
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_use':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    case 'pause':
      return 'pause_turn';
    case 'error':
      return null;
    case 'other':
      return 'end_turn';
    default:
      return 'end_turn';
  }
}
