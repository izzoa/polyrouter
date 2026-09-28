// add-stream-keepalive (task 2.3): the keepalive frames, the terminal-frame detector
// (checked against the REAL serializer terminators and the data-plane terminal error
// frame), the self-re-arming idle timer, and the in-stream error frame — which must
// carry exactly the body the HTTP error path renders, and nothing from upstream.
import { ProviderError, formatSseEvent, terminalErrorFrame } from '@polyrouter/data-plane';
import { IdleTimer, isTerminalFrame, keepaliveFrame } from './stream-keepalive';
import {
  asProxyError,
  proxyErrorFrame,
  renderProxyError,
  type ClientProtocol,
} from './proxy-errors';

describe('keepaliveFrame', () => {
  it('is an SSE comment before the first event for both protocols', () => {
    expect(keepaliveFrame('openai', false)).toBe(': keep-alive\n\n');
    expect(keepaliveFrame('anthropic', false)).toBe(': keep-alive\n\n');
  });

  it("is Anthropic's own ping after the first event, and stays a comment for OpenAI", () => {
    expect(keepaliveFrame('anthropic', true)).toBe('event: ping\ndata: {"type":"ping"}\n\n');
    expect(keepaliveFrame('openai', true)).toBe(': keep-alive\n\n');
  });
});

describe('isTerminalFrame', () => {
  it("recognizes the serializers' success terminators", () => {
    expect(isTerminalFrame('openai', 'data: [DONE]\n\n')).toBe(true);
    expect(isTerminalFrame('openai', 'data: {"choices":[]}\n\ndata: [DONE]\n\n')).toBe(true);
    expect(
      isTerminalFrame('anthropic', formatSseEvent('message_stop', { type: 'message_stop' })),
    ).toBe(true);
  });

  it('recognizes the data-plane terminal error frame and the proxy error frame', () => {
    for (const protocol of ['openai', 'anthropic'] as const) {
      expect(isTerminalFrame(protocol, terminalErrorFrame(protocol, 'x'))).toBe(true);
      const err = asProxyError(new ProviderError('rate_limit', 'slow down'));
      expect(isTerminalFrame(protocol, proxyErrorFrame(protocol, err))).toBe(true);
    }
  });

  it('does not fire on model output that literally contains a terminator line', () => {
    // A model explaining SSE: its text is JSON-encoded inside ONE data line.
    const content = (text: string): string =>
      `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
    expect(isTerminalFrame('openai', content('data: [DONE]'))).toBe(false);
    expect(isTerminalFrame('openai', content('then send\ndata: [DONE]\n\n'))).toBe(false);
    expect(isTerminalFrame('openai', content('data: {"error": 1}'))).toBe(false);
    const anthropicText = formatSseEvent('content_block_delta', {
      delta: { text: 'event: message_stop\nevent: error\n' },
    });
    expect(isTerminalFrame('anthropic', anthropicText)).toBe(false);
  });

  it('does not fire on ordinary content, keepalives, or look-alike text', () => {
    expect(
      isTerminalFrame('openai', 'data: {"choices":[{"delta":{"content":"[DONE]?"}}]}\n\n'),
    ).toBe(false);
    expect(isTerminalFrame('openai', ': keep-alive\n\n')).toBe(false);
    expect(
      isTerminalFrame('anthropic', formatSseEvent('content_block_delta', { text: 'event: error' })),
    ).toBe(false);
    expect(isTerminalFrame('anthropic', keepaliveFrame('anthropic', true))).toBe(false);
  });
});

describe('proxyErrorFrame', () => {
  const cases: Array<[string, unknown]> = [
    ['rate limit', new ProviderError('rate_limit', 'upstream said: SECRET-UPSTREAM-TEXT')],
    ['unknown model', new ProviderError('unknown_model', 'SECRET-UPSTREAM-TEXT')],
    ['upstream error', new ProviderError('unavailable', 'SECRET-UPSTREAM-TEXT')],
  ];

  it.each(cases)(
    'carries the HTTP body for a %s, in each protocol, and no upstream text',
    (_, e) => {
      for (const protocol of ['openai', 'anthropic'] as ClientProtocol[]) {
        const err = asProxyError(e);
        const frame = proxyErrorFrame(protocol, err);
        const { body } = renderProxyError(err, protocol);
        if (protocol === 'openai') {
          expect(frame).toBe(`data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`);
        } else {
          expect(frame).toBe(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
        }
        expect(frame).not.toContain('SECRET-UPSTREAM-TEXT');
      }
    },
  );
});

describe('IdleTimer', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('fires once per idle interval and re-arms itself after every tick', () => {
    const onIdle = jest.fn();
    const t = new IdleTimer(1_000, onIdle);
    t.arm();
    jest.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(3_000);
    expect(onIdle).toHaveBeenCalledTimes(4);
  });

  it('a re-arm restarts the interval (a write resets the idle clock)', () => {
    const onIdle = jest.fn();
    const t = new IdleTimer(1_000, onIdle);
    t.arm();
    jest.advanceTimersByTime(800);
    t.arm();
    jest.advanceTimersByTime(800);
    expect(onIdle).not.toHaveBeenCalled();
    jest.advanceTimersByTime(200);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('stop() is final, and 0 disables it', () => {
    const onIdle = jest.fn();
    const t = new IdleTimer(1_000, onIdle);
    t.arm();
    t.stop();
    t.arm(); // a late re-arm after stop never schedules
    jest.advanceTimersByTime(10_000);
    expect(onIdle).not.toHaveBeenCalled();
    expect(t.armed).toBe(false);
    const off = new IdleTimer(0, onIdle);
    off.arm();
    expect(off.armed).toBe(false);
  });
});
