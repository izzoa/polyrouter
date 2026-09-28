// add-stream-keepalive (task 3.3): the `/v1` SSE pump's keepalive + early response
// commit, against a fake response, a controllable upstream, and fake timers.
// Covers: heartbeat cadence and reset, backpressure skip-and-resume, the terminal
// latch across a slow generator teardown, the early commit (then content, or a late
// failure framed in-stream), fast failures still thrown for the HTTP filter, the
// pre-commit abort that never waits on the upstream, knob independence, the
// unbuffered header, and a teardown that leaves no timer and no drain registration.
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { ProviderError } from '@polyrouter/data-plane';
import type { Principal } from '@polyrouter/shared/server';
import { handleInference, type ProxyHttpDeps } from './proxy-http';
import type { ProxyService } from './proxy.service';
import type { StreamDrainRegistry } from './stream-drain.registry';
import type { StreamKeepaliveConfig } from './proxy.config';
import type { ClientProtocol } from './proxy-errors';

const COMMENT = ': keep-alive\n\n';
const PING = 'event: ping\ndata: {"type":"ping"}\n\n';

class FakeRes extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  writableNeedDrain = false;
  writes: string[] = [];
  flushes = 0;
  /** When false, the next write reports backpressure (and sets writableNeedDrain). */
  acceptWrites = true;
  status(c: number): this {
    this.statusCode = c;
    return this;
  }
  setHeader(k: string, v: string): void {
    this.headers[k] = v;
  }
  flushHeaders(): void {
    this.headersSent = true;
    this.flushes += 1;
  }
  write(chunk: string): boolean {
    this.writes.push(chunk);
    if (!this.acceptWrites) {
      this.writableNeedDrain = true;
      return false;
    }
    return true;
  }
  end(): void {
    this.writableEnded = true;
  }
  destroy(): void {
    this.destroyed = true;
  }
  json(): void {
    /* the pump never renders JSON; the /v1 filter does */
  }
  /** The socket drained. */
  drained(): void {
    this.writableNeedDrain = false;
    this.acceptWrites = true;
    this.emit('drain');
  }
  keepalives(): string[] {
    return this.writes.filter((w) => w === COMMENT || w === PING);
  }
  content(): string[] {
    return this.writes.filter((w) => w !== COMMENT && w !== PING);
  }
}

/** A controllable upstream: push frames, end it, and gate its teardown (the real
 * generator yields its last frame and then awaits cleanup before finishing). */
function upstream() {
  const buffered: Array<string | null> = [];
  let wake: ((v: string | null) => void) | null = null;
  let teardown: Promise<void> = Promise.resolve();
  const push = (v: string | null): void => {
    if (wake) {
      const w = wake;
      wake = null;
      w(v);
    } else buffered.push(v);
  };
  async function* gen(): AsyncGenerator<string> {
    try {
      for (;;) {
        const v =
          buffered.length > 0
            ? buffered.shift()!
            : await new Promise<string | null>((r) => (wake = r));
        if (v === null) return;
        yield v;
      }
    } finally {
      await teardown;
    }
  }
  return {
    frames: gen(),
    push,
    end: (): void => push(null),
    slowTeardown(): () => void {
      let release!: () => void;
      teardown = new Promise<void>((r) => (release = r));
      return release;
    },
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function harness(opts: { protocol?: ClientProtocol; keepalive?: StreamKeepaliveConfig } = {}) {
  const res = new FakeRes();
  const first = deferred<AsyncGenerator<string>>();
  const active = new Set<AbortController>();
  let signal: AbortSignal | undefined;
  const svc = {
    stream: jest.fn((...args: unknown[]) => {
      signal = args[4] as AbortSignal;
      return first.promise;
    }),
  } as unknown as ProxyService;
  const registry = {
    isDraining: () => false,
    register: (c: AbortController) => active.add(c),
    deregister: (c: AbortController) => active.delete(c),
  } as unknown as StreamDrainRegistry;
  const deps: ProxyHttpDeps = {
    svc,
    registry,
    keepalive: opts.keepalive ?? { heartbeatMs: 1_000, earlyCommitMs: 3_000 },
  };
  const run = handleInference(
    deps,
    opts.protocol ?? 'openai',
    { kind: 'user', userId: 'u1' } as Principal,
    { stream: true },
    { headers: {} } as unknown as Request,
    res as unknown as Response,
  );
  // Observe completion without letting a rejection go unhandled.
  const settled = run.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return { res, first, active, run: settled, signal: () => signal };
}

const tick = (): Promise<void> => jest.advanceTimersByTimeAsync(0);

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('after commit: keepalives bridge silence', () => {
  it('sends one keepalive per silent interval, none while frames flow, and resets on each write', async () => {
    const h = harness();
    const up = upstream();
    h.first.resolve(up.frames);
    up.push('data: {"a":1}\n\n');
    await tick();
    expect(h.res.headers['Content-Type']).toBe('text/event-stream');
    expect(h.res.headers['X-Accel-Buffering']).toBe('no');
    // Frames every 600ms keep the stream busy: no keepalive at a 1s interval.
    for (let i = 0; i < 4; i += 1) {
      await jest.advanceTimersByTimeAsync(600);
      up.push(`data: {"i":${String(i)}}\n\n`);
      await tick();
    }
    expect(h.res.keepalives()).toEqual([]);
    // Then silence (a thinking phase): one comment per second.
    await jest.advanceTimersByTimeAsync(3_000);
    expect(h.res.keepalives()).toEqual([COMMENT, COMMENT, COMMENT]);
    up.push('data: [DONE]\n\n');
    up.end();
    expect(await h.run).toEqual({ ok: true });
    expect(h.res.writableEnded).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    expect(h.active.size).toBe(0);
  });

  it("uses Anthropic's ping after the first event, and only comments before it", async () => {
    const h = harness({ protocol: 'anthropic' });
    await jest.advanceTimersByTimeAsync(3_000); // early commit, no first event yet
    await jest.advanceTimersByTimeAsync(2_000);
    expect(h.res.keepalives().length).toBeGreaterThanOrEqual(2);
    expect(h.res.keepalives().every((k) => k === COMMENT)).toBe(true);
    const up = upstream();
    h.first.resolve(up.frames);
    up.push('event: message_start\ndata: {"type":"message_start"}\n\n');
    await tick();
    const firstParsed = h.res.writes.find((w) => w !== COMMENT);
    expect(firstParsed).toMatch(/^event: message_start/);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(h.res.writes.at(-1)).toBe(PING);
    up.push('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    up.end();
    expect(await h.run).toEqual({ ok: true });
  });

  it('skips a keepalive while the socket needs a drain, and resumes after it', async () => {
    const h = harness();
    const up = upstream();
    h.first.resolve(up.frames);
    h.res.acceptWrites = false; // the first frame hits backpressure
    up.push('data: {"a":1}\n\n');
    await tick();
    const before = h.res.writes.length;
    await jest.advanceTimersByTimeAsync(3_000); // three ticks while the socket is full
    expect(h.res.writes.length).toBe(before); // skipped — never queued
    h.res.drained();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(h.res.keepalives()).toEqual([COMMENT]); // the heartbeat survived the skips
    up.push('data: [DONE]\n\n');
    up.end();
    await h.run;
  });

  it.each([
    ['success', 'data: [DONE]\n\n'],
    [
      'error',
      'data: {"error":{"message":"x","type":"upstream_error","code":null}}\n\ndata: [DONE]\n\n',
    ],
  ])(
    'writes no keepalive after the terminal frame (%s) while the generator teardown outlasts the interval',
    async (_label, terminalFrame) => {
      const h = harness();
      const up = upstream();
      const release = up.slowTeardown();
      h.first.resolve(up.frames);
      up.push('data: {"a":1}\n\n');
      up.push(terminalFrame);
      up.end();
      await tick();
      await jest.advanceTimersByTimeAsync(5_000); // teardown still pending
      expect(h.res.keepalives()).toEqual([]);
      expect(h.res.writes.at(-1)).toBe(terminalFrame);
      release();
      expect(await h.run).toEqual({ ok: true });
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('writes nothing after a client close and leaves no timer or registration', async () => {
    const h = harness();
    const up = upstream();
    h.first.resolve(up.frames);
    up.push('data: {"a":1}\n\n');
    await tick();
    h.res.emit('close');
    up.end(); // the aborted upstream finishes
    await h.run;
    const writes = h.res.writes.length;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(h.res.writes.length).toBe(writes);
    expect(h.res.destroyed).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    expect(h.active.size).toBe(0);
  });
});

describe('before commit: the delayed early response commit', () => {
  it('a fast first event commits normally: no early headers, no stale timer later', async () => {
    const h = harness();
    const up = upstream();
    h.first.resolve(up.frames);
    up.push('data: {"a":1}\n\n');
    up.push('data: [DONE]\n\n');
    up.end();
    expect(await h.run).toEqual({ ok: true });
    expect(h.res.flushes).toBe(1);
    await jest.advanceTimersByTimeAsync(10_000); // past the early-commit delay
    expect(h.res.flushes).toBe(1);
    expect(h.res.keepalives()).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a slow first event: 200 + headers + comments at the delay, then the content', async () => {
    const h = harness();
    await jest.advanceTimersByTimeAsync(2_999);
    expect(h.res.headersSent).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(h.res.statusCode).toBe(200);
    expect(h.res.headersSent).toBe(true);
    expect(h.res.headers['X-Accel-Buffering']).toBe('no');
    expect(h.res.writes).toEqual([COMMENT]);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(h.res.keepalives().length).toBe(3);
    const up = upstream();
    h.first.resolve(up.frames);
    up.push('data: {"a":1}\n\n');
    up.push('data: [DONE]\n\n');
    up.end();
    expect(await h.run).toEqual({ ok: true });
    expect(h.res.flushes).toBe(1); // headers were committed once
    expect(h.res.content()).toEqual(['data: {"a":1}\n\n', 'data: [DONE]\n\n']);
  });

  it("the early commit's first keepalive also respects backpressure (skipped, then resumes)", async () => {
    const h = harness();
    // The header flush leaves the socket needing a drain.
    const flush = h.res.flushHeaders.bind(h.res);
    h.res.flushHeaders = (): void => {
      flush();
      h.res.writableNeedDrain = true;
    };
    await jest.advanceTimersByTimeAsync(3_000);
    expect(h.res.headersSent).toBe(true);
    expect(h.res.writes).toEqual([]); // not written into a full socket
    await jest.advanceTimersByTimeAsync(2_000);
    expect(h.res.writes).toEqual([]); // still full: every tick skips
    h.res.drained();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(h.res.keepalives()).toEqual([COMMENT]); // resumes once it can take it
    h.first.reject(new ProviderError('unavailable', 'x'));
    await h.run;
  });

  it.each(['openai', 'anthropic'] as const)(
    'a late pre-commit failure (%s) arrives as exactly one in-stream error frame',
    async (protocol) => {
      const h = harness({ protocol });
      await jest.advanceTimersByTimeAsync(3_500); // early-committed
      h.first.reject(new ProviderError('rate_limit', 'SECRET upstream text'));
      expect(await h.run).toEqual({ ok: true }); // nothing thrown to the HTTP filter
      const errs = h.res.content();
      expect(errs).toHaveLength(1);
      if (protocol === 'openai') {
        expect(errs[0]).toMatch(/^data: \{"error":\{"message":/);
        expect(errs[0]!.endsWith('data: [DONE]\n\n')).toBe(true);
      } else {
        expect(errs[0]).toMatch(/^event: error\ndata: \{"type":"error"/);
      }
      expect(errs[0]).not.toContain('SECRET');
      expect(h.res.writableEnded).toBe(true);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(h.res.writes.at(-1)).toBe(errs[0]); // no keepalive after the error frame
      expect(jest.getTimerCount()).toBe(0);
      expect(h.active.size).toBe(0);
    },
  );

  it('a fast pre-commit failure is still thrown for the HTTP filter, untouched', async () => {
    const h = harness();
    h.first.reject(new ProviderError('rate_limit', 'slow down'));
    const r = await h.run;
    expect(r.ok).toBe(false);
    expect(h.res.headersSent).toBe(false);
    expect(h.res.writes).toEqual([]);
    expect(h.active.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a client close in the pre-commit window ends at once, never waiting on the upstream', async () => {
    const h = harness();
    await jest.advanceTimersByTimeAsync(3_500); // early-committed, upstream still pending
    h.res.emit('close');
    // The upstream NEVER settles — the pump must not wait for it.
    expect(await h.run).toEqual({ ok: true });
    expect(h.res.destroyed).toBe(true);
    expect(h.signal()!.aborted).toBe(true);
    expect(h.active.size).toBe(0);
    const n = h.res.writes.length;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(h.res.writes.length).toBe(n); // no error frame, no keepalive to a gone client
    expect(jest.getTimerCount()).toBe(0);
    // A late success still releases its iterator (detached, never unhandled).
    const up = upstream();
    const ret = jest.spyOn(up.frames, 'return');
    h.first.resolve(up.frames);
    await tick();
    expect(ret).toHaveBeenCalled();
  });
});

describe('knob independence', () => {
  it('heartbeat 0 with an early commit sends the headers alone', async () => {
    const h = harness({ keepalive: { heartbeatMs: 0, earlyCommitMs: 3_000 } });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(h.res.headersSent).toBe(true);
    expect(h.res.writes).toEqual([]);
    const up = upstream();
    h.first.resolve(up.frames);
    up.push('data: {"a":1}\n\n');
    await tick();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(h.res.keepalives()).toEqual([]);
    up.push('data: [DONE]\n\n');
    up.end();
    await h.run;
  });

  it('early commit 0: no headers before the first event however long; heartbeats after it', async () => {
    const h = harness({ keepalive: { heartbeatMs: 1_000, earlyCommitMs: 0 } });
    await jest.advanceTimersByTimeAsync(50_000);
    expect(h.res.headersSent).toBe(false);
    expect(h.res.writes).toEqual([]);
    const up = upstream();
    h.first.resolve(up.frames);
    up.push('data: {"a":1}\n\n');
    await tick();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(h.res.keepalives()).toEqual([COMMENT]);
    up.push('data: [DONE]\n\n');
    up.end();
    await h.run;
  });

  it('both 0: exactly the upstream frames, nothing else', async () => {
    const h = harness({ keepalive: { heartbeatMs: 0, earlyCommitMs: 0 } });
    await jest.advanceTimersByTimeAsync(60_000);
    const up = upstream();
    h.first.resolve(up.frames);
    const frames = ['data: {"a":1}\n\n', 'data: {"b":2}\n\n', 'data: [DONE]\n\n'];
    for (const f of frames) up.push(f);
    await jest.advanceTimersByTimeAsync(60_000);
    up.end();
    await h.run;
    expect(h.res.writes).toEqual(frames);
    expect(h.res.flushes).toBe(1);
  });
});
