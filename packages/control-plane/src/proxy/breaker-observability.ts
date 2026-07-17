import { Logger } from '@nestjs/common';
import type { ProxyMetrics } from '../observability/proxy-metrics';

/** Log at most once per this window: the hook fires on EVERY degraded call, so an
 * unthrottled log would storm during a Redis outage. Long enough to suppress the
 * storm, short enough to re-surface a sustained outage as a heartbeat. */
const WARN_THROTTLE_MS = 60_000;

/**
 * Build the production `CircuitBreaker.onError` hook (A-10). A shared (Redis)
 * breaker-store fault means the breaker degraded to its per-instance in-memory
 * fallback — the circuit is no longer coordinated across replicas until Redis
 * recovers. This hook makes that observable: it **meters every** fault
 * (`polyrouter_breaker_store_faults_total`) and logs a **throttled** WARN naming only
 * the error code/name — never the message, which may carry connection detail
 * (invariant 8). It never throws into the breaker's hot path. `now` is injectable
 * for tests.
 */
export function breakerStoreErrorHandler(
  metrics: Pick<ProxyMetrics, 'breakerStoreDegraded'>,
  logger: Pick<Logger, 'warn'>,
  now: () => number = () => Date.now(),
): (err: unknown) => void {
  let lastWarnedAt = Number.NEGATIVE_INFINITY; // first fault always logs, any clock base
  return (_err: unknown): void => {
    try {
      metrics.breakerStoreDegraded();
      const t = now();
      if (t - lastWarnedAt < WARN_THROTTLE_MS) return; // throttled: leave the window intact
      lastWarnedAt = t;
      // A STATIC message — the error object is deliberately never read. Its `code`/
      // `name`/`message` could be a stateful getter or carry a secret/URL/newline, and
      // interpolating any of it risks a leak or log injection (invariant 8). The counter
      // above carries the machine-readable signal; the operator knows the breaker store
      // is Redis, so a bare "degraded" WARN is enough to act on.
      logger.warn('breaker store degraded to per-instance fallback (cross-replica coordination lost)');
    } catch {
      /* observability must never break the breaker's hot path */
    }
  };
}
