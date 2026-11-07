import type { PlanUsageObservation, PlanUsageRecorder } from '@polyrouter/data-plane';

/**
 * Where an attempt's observations go: the proxy's `CircuitBreaker` hosts the shared recorder
 * and exposes `observePlanUsage`; management (Test, manual sync) holds the recorder directly and
 * adapts it with `recorderSink`. Both are synchronous and never throw.
 */
export interface PlanUsageSink {
  observePlanUsage(providerId: string, obs: PlanUsageObservation, gen: number): void;
}

/** A sink over a bare recorder (the management paths hold no breaker). */
export function recorderSink(recorder: PlanUsageRecorder): PlanUsageSink {
  return { observePlanUsage: (providerId, obs, gen) => recorder.offer(providerId, obs, gen) };
}

/**
 * The per-attempt `onPlanUsage` callback (add-subscription-quota-display, design D6). A plain
 * function, so no constructor argument changes anywhere (the inference-proxy e2e wires
 * `ProxyService` by hand). `gen` is the snapshot generation the CALLER read BEFORE it loaded the
 * row it acts on, so an observation made with a replaced credential carries an older generation
 * than the clear that replaced it and the merge drops it (design D5). The adapter already
 * contains a throw from the callback; the `try` here keeps the hook safe on its own too.
 */
export function planUsageHook(
  sink: PlanUsageSink,
  providerId: string,
  gen: number,
): (obs: PlanUsageObservation) => void {
  return (obs) => {
    try {
      sink.observePlanUsage(providerId, obs, gen);
    } catch {
      /* capture can never break a request */
    }
  };
}
