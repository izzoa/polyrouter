/**
 * `/v1` stream keepalives (add-stream-keepalive). A transport concern — never a
 * model event: nothing here enters the translated event stream, usage, cost, or the
 * recorded row, so the translate module stays pure (invariant 2).
 *
 * Reverse proxies / CDNs reap a connection its origin leaves silent (Cloudflare at
 * ~100s). A keepalive before the first serialized event is an SSE COMMENT for both
 * protocols — dropped by every conforming SSE parser before event dispatch, so an
 * Anthropic client never sees an event ahead of `message_start`. After it, Anthropic
 * gets its own `ping` (what the Anthropic API disperses through a stream); OpenAI
 * keeps the comment (the OpenAI SDK decoders drop comment lines).
 */
import type { ClientProtocol } from './proxy-errors';

const COMMENT = ': keep-alive\n\n';
const ANTHROPIC_PING = 'event: ping\ndata: {"type":"ping"}\n\n';

export function keepaliveFrame(protocol: ClientProtocol, afterFirstEvent: boolean): string {
  return protocol === 'anthropic' && afterFirstEvent ? ANTHROPIC_PING : COMMENT;
}

// Anchored to a REAL SSE line start: model output is JSON-encoded inside a `data:`
// line (its newlines are escaped), so literal text like `data: [DONE]` in an answer
// can never start a line of its own — a substring match would end the heartbeat
// for the rest of a valid stream.
const OPENAI_DONE = /(^|\n)data: \[DONE\](\n|$)/;
const OPENAI_ERROR = /(^|\n)data: \{"error"/;
const ANTHROPIC_TERMINAL = /(^|\n)event: (message_stop|error)\n/;

/** Whether a written frame carries the stream's TERMINATOR — the success end
 * (`data: [DONE]` / `event: message_stop`) or a terminal error event. After it no
 * keepalive may follow, even while the upstream generator still runs its teardown
 * (it yields the last frame, then awaits cleanup before finishing). */
export function isTerminalFrame(protocol: ClientProtocol, frame: string): boolean {
  if (protocol === 'anthropic') return ANTHROPIC_TERMINAL.test(frame);
  return OPENAI_DONE.test(frame) || OPENAI_ERROR.test(frame);
}

/** A resettable one-shot timer that re-arms itself after each tick (so a keepalive
 * SKIPPED for backpressure never ends the heartbeat). `ms <= 0` disables it. */
export class IdleTimer {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly ms: number,
    private readonly onIdle: () => void,
  ) {}

  /** (Re)start the interval from now — call after every client write. */
  arm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped || this.ms <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.stopped) return;
      this.onIdle();
      this.arm(); // every tick re-arms, whether the keepalive was written or skipped
    }, this.ms);
  }

  /** Stop for good (terminal frame, end, abort): no tick fires after this returns. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  get armed(): boolean {
    return this.timer !== undefined;
  }
}
