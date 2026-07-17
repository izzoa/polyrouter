// E15.2: exercise the PRODUCTION tracing switch — `initTracing`/`shutdownTracing`
// (the OTEL_ENABLED gate, the OTLP exporter, the BatchSpanProcessor). Every other
// suite registers its own in-memory provider, so this path was never executed: a
// regression that made `initTracing` throw, block a request, fail to register, or
// break the drain would ship undetected.
//
// Note on flush: the OTLP HTTP exporter's network send does not execute under the
// jest `node` test environment (confirmed against a standalone repro where the same
// provider flushes to an in-process collector on shutdown). So the drain is asserted
// via a clean, resolving `shutdownTracing()` that releases the provider (a hung or
// throwing shutdown fails), not via a captured export POST.
import { context, propagation, trace } from '@opentelemetry/api';
import { initTracing, shutdownTracing, TRACER_NAME } from './tracing';

describe('initTracing / shutdownTracing (#21, E15.2)', () => {
  const saved = {
    OTEL_ENABLED: process.env['OTEL_ENABLED'],
    OTEL_EXPORTER_OTLP_ENDPOINT: process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'],
  };

  afterEach(async () => {
    await shutdownTracing(); // idempotent; stops the SDK processor + its timer
    // `shutdown()` stops processors but does NOT unregister the API globals — reset
    // them so a registered provider can't leak into the next test (order-independent
    // even under `jest --randomize`).
    trace.disable();
    context.disable();
    propagation.disable();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('is a no-op when OTEL_ENABLED is unset (registers no SDK provider)', () => {
    delete process.env['OTEL_ENABLED'];
    expect(() => initTracing()).not.toThrow();
    // With no provider registered, the API hands back a no-op tracer whose spans
    // never record — the disabled default that must never affect a request.
    const span = trace.getTracer(TRACER_NAME).startSpan('probe');
    expect(span.isRecording()).toBe(false);
    span.end();
  });

  it('registers a recording provider under OTEL_ENABLED=true and never blocks the request path (unreachable collector)', async () => {
    process.env['OTEL_ENABLED'] = 'true';
    // A well-formed OTLP endpoint at a closed port — a request must be unaffected
    // whether or not the collector is reachable (export is batched/async).
    delete process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']; // no ambient signal override
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://127.0.0.1:9';

    const started = Date.now();
    expect(() => initTracing()).not.toThrow();
    expect(() => initTracing()).not.toThrow(); // idempotent — the second call is a no-op

    // A "request": do work inside a span. A real SDK provider is now registered so
    // the span records; the (unreachable) collector cannot slow this synchronous path.
    let ran = false;
    trace.getTracer(TRACER_NAME).startActiveSpan('proxy.request', (span) => {
      ran = true;
      expect(span.isRecording()).toBe(true); // proves the provider registered
      span.end();
    });
    expect(ran).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000); // never blocked on the collector

    // Graceful drain resolves cleanly — a hung or throwing shutdown fails here.
    await expect(shutdownTracing()).resolves.toBeUndefined();
  });

  it('shutdownTracing is idempotent (safe with no provider)', async () => {
    await expect(shutdownTracing()).resolves.toBeUndefined();
    await expect(shutdownTracing()).resolves.toBeUndefined();
  });
});
