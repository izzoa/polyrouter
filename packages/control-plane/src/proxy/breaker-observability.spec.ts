import { breakerStoreErrorHandler } from './breaker-observability';

describe('breakerStoreErrorHandler (A-10)', () => {
  function harness() {
    const degraded = jest.fn();
    const warn = jest.fn();
    let now = 0;
    const handler = breakerStoreErrorHandler(
      { breakerStoreDegraded: degraded },
      { warn } as unknown as { warn: (m: string) => void } & import('@nestjs/common').Logger,
      () => now,
    );
    return { degraded, warn, handler, tick: (ms: number) => (now += ms) };
  }

  it('meters every fault but throttles the log to once per window', () => {
    const { degraded, warn, handler, tick } = harness();
    handler({ code: 'ECONNREFUSED' });
    handler({ code: 'ECONNREFUSED' });
    handler({ code: 'ECONNREFUSED' });
    expect(degraded).toHaveBeenCalledTimes(3); // metered on EVERY fault
    expect(warn).toHaveBeenCalledTimes(1); // logged once (throttled)
    tick(60_000); // window elapsed
    handler({ code: 'ECONNREFUSED' });
    expect(warn).toHaveBeenCalledTimes(2); // re-surfaces a sustained outage
  });

  it('logs a STATIC message — the error object is never read (invariant 8)', () => {
    const { warn, handler } = harness();
    // A hostile error: a stateful getter that could leak on a later read, plus a
    // secret-bearing message. None of it may reach the log.
    let reads = 0;
    const hostile = {
      get code() {
        reads += 1;
        return reads > 1 ? 'redis://user:secret@10.0.0.1\nINJECTED' : 'ECONNREFUSED';
      },
      message: 'redis://user:secret@10.0.0.1:6379 timed out',
    };
    handler(hostile);
    const line = warn.mock.calls[0]![0] as string;
    expect(line).toBe('breaker store degraded to per-instance fallback (cross-replica coordination lost)');
    expect(line).not.toContain('secret');
    expect(line).not.toContain('10.0.0.1');
    expect(line).not.toContain('INJECTED');
    expect(line).not.toContain('\n');
    expect(reads).toBe(0); // the error object is not read at all
  });

  it('is null-safe: a null/non-object error still meters and logs, no throw', () => {
    const { degraded, warn, handler } = harness();
    expect(() => handler(null)).not.toThrow();
    expect(degraded).toHaveBeenCalledTimes(1); // metered
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never throws into the breaker hot path even if metrics throw', () => {
    const handler = breakerStoreErrorHandler(
      {
        breakerStoreDegraded: () => {
          throw new Error('boom');
        },
      },
      { warn: () => undefined } as unknown as import('@nestjs/common').Logger,
      () => 0,
    );
    expect(() => handler({ code: 'X' })).not.toThrow();
  });
});
