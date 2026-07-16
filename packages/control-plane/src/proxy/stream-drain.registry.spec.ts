// Unit coverage for the invariant-12 drain registry (ci-pipeline spec: "Stream
// drain, disconnect, and backpressure have automated coverage"). The registry's
// primitives only — deregister-on-error is `handleInference` behavior and is
// covered by the stream-lifecycle e2e. Real timers with a short injected
// deadline: the drain loop polls every 50ms, so all bounds stay well under a
// second.
import { StreamDrainRegistry } from './stream-drain.registry';
import type { ProxyRuntime } from './proxy.config';

const runtime = (streamDrainDeadlineMs: number): ProxyRuntime => ({
  key: 'k'.repeat(64),
  mode: 'selfhosted',
  defaultMaxOutputTokens: 4096,
  firstByteTimeoutMs: 30_000,
  firstEventTimeoutMs: 30_500,
  maxBodyBytes: 10_485_760,
  streamDrainDeadlineMs,
});

describe('StreamDrainRegistry', () => {
  it('starts idle and tracks register/deregister without draining', () => {
    const reg = new StreamDrainRegistry(runtime(200));
    expect(reg.isDraining()).toBe(false);

    const c = new AbortController();
    reg.register(c);
    reg.deregister(c);
    expect(reg.isDraining()).toBe(false);
    expect(c.signal.aborted).toBe(false);
  });

  it('flips isDraining and resolves promptly once in-flight streams deregister', async () => {
    const reg = new StreamDrainRegistry(runtime(5_000)); // deadline far away — completion drives the resolve
    const c = new AbortController();
    reg.register(c);

    const drain = reg.beforeApplicationShutdown();
    expect(reg.isDraining()).toBe(true);

    // Simulate the stream finishing shortly after shutdown begins.
    setTimeout(() => reg.deregister(c), 75);

    const started = Date.now();
    await drain;
    const took = Date.now() - started;

    expect(c.signal.aborted).toBe(false); // finished streams are never aborted
    expect(took).toBeLessThan(1_000); // resolved by deregistration, not the 5s deadline
    expect(reg.isDraining()).toBe(true); // draining is terminal — new work stays refused
  });

  it('aborts a straggler still registered when the deadline elapses', async () => {
    const deadlineMs = 200;
    const reg = new StreamDrainRegistry(runtime(deadlineMs));
    const straggler = new AbortController();
    reg.register(straggler);

    const started = Date.now();
    await reg.beforeApplicationShutdown();
    const took = Date.now() - started;

    expect(straggler.signal.aborted).toBe(true);
    expect(took).toBeGreaterThanOrEqual(deadlineMs - 5); // waited the full deadline first
  });

  it('aborts only stragglers — streams that finished during the drain are untouched', async () => {
    const reg = new StreamDrainRegistry(runtime(200));
    const finished = new AbortController();
    const straggler = new AbortController();
    reg.register(finished);
    reg.register(straggler);

    const drain = reg.beforeApplicationShutdown();
    setTimeout(() => reg.deregister(finished), 60);
    await drain;

    expect(finished.signal.aborted).toBe(false);
    expect(straggler.signal.aborted).toBe(true);
  });

  it('resolves immediately when nothing is in flight', async () => {
    const reg = new StreamDrainRegistry(runtime(5_000));
    const started = Date.now();
    await reg.beforeApplicationShutdown();
    expect(Date.now() - started).toBeLessThan(100);
  });
});
