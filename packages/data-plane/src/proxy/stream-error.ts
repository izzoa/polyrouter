/**
 * #10-local terminal-error SSE frames. #5's `streamSerialize` cannot carry a
 * safe terminal error (OpenAI drops IR error events; Anthropic forwards the raw
 * upstream message), so the commit-gated coordinator emits these instead — a
 * FIXED, sanitized message in the client's own streaming-error shape. #5 stays
 * unmodified. The upstream terminator ([DONE] / message_stop) is never reached
 * on the error path, so this replaces it.
 */
import { formatSseData, formatSseEvent, type Protocol } from './translate';

export function terminalErrorFrame(protocol: Protocol, message: string): string {
  if (protocol === 'openai') {
    // OpenAI clients treat a `data: {"error":…}` frame as a stream error; close with [DONE].
    return (
      formatSseData({ error: { message, type: 'upstream_error', code: null } }) + 'data: [DONE]\n\n'
    );
  }
  // Anthropic ends the stream on an `error` event (no message_stop needed).
  return formatSseEvent('error', { type: 'error', error: { type: 'api_error', message } });
}
