/**
 * Probe patience (add-fallback-attempt-detail, O1-C): the breaker's half-open
 * probe runs with WIDENED typed bounds — twice the member's effective bounds,
 * capped at the configuration ceiling — so a healthy-but-slow provider tripped
 * by workload-shaped timeouts can pass its probe on the same workload and close
 * the breaker instead of being re-tripped indefinitely. A probe silent past its
 * widened bound still times out typed, still trips, and re-opens: hung-provider
 * detection is preserved, its latency on the probe path at most doubled.
 */

/** ×2 — a constant, not a knob: per-provider `first_byte_timeout_ms` overrides
 * remain the real tuning surface for heavy chains. */
export const PROBE_PATIENCE_MULTIPLIER = 2;

/** Ceiling on any widened bound — the 1 h config ceiling (Node timers clamp
 * near 2^31-1 ms; no legitimate time-to-first-token exceeds this). */
export const PROBE_BOUND_CEILING_MS = 3_600_000;

/** Headroom the GRANTED probe lease sits above the widest legal silence, so a
 * probe answering at the last legal instant still settles inside its lease. */
export const PROBE_SETTLE_HEADROOM_MS = 5_000;

/** The shared store record must strictly OUTLIVE the granted lease: at equality
 * the record could expire at `probeExpiresAt` exactly, and the next admission
 * would read a VANISHED record as `closed` — admitting overlapping calls and
 * bypassing the generation-bumping reclaim the expired-probe contract
 * guarantees — instead of superseding the probe. */
export const PROBE_RECORD_TTL_HEADROOM_MS = 60_000;

export interface ProbePatience {
  /** Widened adapter first-byte bound: `min(2 × effective, ceiling)`. */
  readonly firstByteTimeoutMs: number;
  /** Widened buffered idle bound — independently resolved, independently doubled. */
  readonly idleTimeoutMs: number;
  /** Widened core first/inter-event bound: widened first-byte + the fixed margin
   * (the adapter-first layer ordering holds at and below the ceiling). */
  readonly firstEventTimeoutMs: number;
  /** The lease to request AT ADMISSION: widest widened silence bound + settle
   * headroom — a deliberately patient probe must not be reclaimed and
   * superseded mid-legal-silence (its success would be ignored as stale). */
  readonly leaseMs: number;
}

const widen = (ms: number): number =>
  Math.min(ms * PROBE_PATIENCE_MULTIPLIER, PROBE_BOUND_CEILING_MS);

/** Derive a member's probe-patience bounds from its EFFECTIVE (override-
 * resolved) bounds. Pure. The caller supplies the same fixed margin core
 * derives its stream bound with, so the widened event bound keeps the
 * adapter's typed timer winning pre-headers races. */
export function probePatienceOf(bounds: {
  firstByteTimeoutMs: number;
  idleTimeoutMs: number;
  eventMarginMs: number;
}): ProbePatience {
  const firstByteTimeoutMs = widen(bounds.firstByteTimeoutMs);
  const idleTimeoutMs = widen(bounds.idleTimeoutMs);
  const firstEventTimeoutMs = firstByteTimeoutMs + bounds.eventMarginMs;
  return {
    firstByteTimeoutMs,
    idleTimeoutMs,
    firstEventTimeoutMs,
    leaseMs: Math.max(firstEventTimeoutMs, idleTimeoutMs) + PROBE_SETTLE_HEADROOM_MS,
  };
}
