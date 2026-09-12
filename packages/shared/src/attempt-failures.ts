/**
 * Per-attempt failure metadata recorded on `status='error'` request-log rows
 * (add-fallback-attempt-detail): one ordered entry per PRE-COMMIT walked-and-
 * failed or circuit-skipped chain member, aggregated across every executed leg
 * (cascade: cheap leg first, then escalation; indices are leg-relative with
 * `leg` as the discriminator). Structure only — the shape deliberately admits
 * NO free-text field (kinds are taxonomy values; provider/model identifiers
 * already appear in the routing reason, and retained markers are allowlisted
 * identifiers), preserving the recorded decision that superseded members
 * contribute no verbatim PROSE.
 */
export interface AttemptFailureEntry {
  /** Leg-relative walk position (`leg` disambiguates across legs). */
  readonly index: number;
  readonly providerId: string | null;
  /** The member's external model id (already present in the routing reason). */
  readonly model: string;
  /** The mapped provider-error taxonomy kind. A circuit-open skip maps to
   * `unavailable` mechanically — skip-ness is `dispatched: false`, not a kind. */
  readonly kind: string;
  /** Upstream HTTP status, ONLY when one existed (timeouts, socket faults,
   * SSRF refusals, and breaker skips have none — that absence is the signal). */
  readonly status?: number;
  /** False ONLY for a circuit-open skip — the member was never sent upstream. */
  readonly dispatched: boolean;
  /** The provider's retained classification values for THIS attempt
   * (fix-bad-request-dead-end), admitted through the marker gates. An allowlisted
   * identifier is not free text: the recorded decision that superseded members
   * contribute no verbatim PROSE is preserved — no message field exists here.
   * Absent on entries predating capture, which read as unknown. */
  readonly markers?: readonly string[];
  /** The executed cascade leg; absent for a primary (non-cascade) chain. */
  readonly leg?: 'cheap' | 'escalation';
  /** Recorder-set: this entry IS the chain's terminal error (final-leg
   * exhaustion only). A non-retryable stop's or a post-commit stream failure's
   * terminal error never enters the failure list, so no entry is marked then. */
  readonly terminal?: boolean;
}

/** Hard bound on recorded entries (real chains are ≤ ~10 even concatenated;
 * the routing reason's trail remains the complete record regardless). */
export const ATTEMPT_FAILURES_MAX = 32;
