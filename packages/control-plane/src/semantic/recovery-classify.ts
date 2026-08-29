import { CentroidValidationError } from '@polyrouter/data-plane';
import { EmbedError } from './embed-core';

/**
 * Whether a failed centroid build is worth rebuilding out of band
 * (recover-semantic-centroid-build).
 *
 * The fault class decides completely, and the split is not a heuristic:
 *
 *  - **retryable** — the HOST was slow or busy for an interval. The inputs
 *    (anchors, embedder, extractor, thresholds) are fixed for the process's
 *    lifetime, so a later execution is the same computation with more time.
 *  - **terminal** — the result is a function of those same fixed inputs, so a
 *    repeat is near-certain. Retrying would spend slots on arithmetic that
 *    cannot come out differently and bury the one error an operator must act
 *    on. Also terminal: anything we cannot classify, because a wrong
 *    "retryable" is the expensive mistake and a wrong "terminal" costs only an
 *    automatic recovery a restart still provides.
 *
 * Exhaustiveness is enforced by the compiler rather than by a test: two
 * successive drafts of this change each left a kind unassigned (`invalid_output`
 * first, then `runtime`), and a table-driven test only catches that if someone
 * remembers to extend the table. Adding a kind to `EmbedError` now fails the
 * build here until it is classified.
 */
export type RecoveryClass = 'retryable' | 'terminal';

/**
 * `runtime` is TERMINAL by deliberate choice, not oversight: it covers both
 * deterministic tokenizer/tensor-setup failures and transient session
 * failures. Until those are split into separate kinds the deterministic half
 * governs, because it is the half that must not be retried.
 */
const BY_KIND = {
  timeout: 'retryable',
  saturated: 'retryable',
  // Classified by CAUSE at the call site, never by kind — a budget abort, a
  // shutdown abort and a traffic abort mean entirely different things.
  aborted: 'terminal',
  invalid_output: 'terminal',
  runtime: 'terminal',
} as const satisfies Record<EmbedError['kind'], RecoveryClass>;

/** The phase's budget ran out — the host was slow, the bundle is fine. */
export class PhaseBudgetError extends Error {
  constructor(
    readonly phase: string,
    readonly budgetMs: number,
  ) {
    super(`${phase} anchor build exceeded its ${String(budgetMs)}ms boot budget`);
    this.name = 'PhaseBudgetError';
  }
}

/** Classify a failed build. Unknown ⇒ terminal (the safe direction). */
export function classifyBuildFailure(err: unknown): RecoveryClass {
  if (err instanceof PhaseBudgetError) return 'retryable';
  if (err instanceof CentroidValidationError) return 'terminal';
  if (err instanceof EmbedError) return BY_KIND[err.kind];
  return 'terminal';
}
