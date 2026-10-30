import type { AttemptBilling } from '../proxy/core';

/**
 * Fold a walk's billing evidence into the single "no provider ran this" verdict
 * (zero-cost-unbilled-errors, design D2). True iff the evidence is NON-EMPTY and
 * every entry is `not_sent` or `rejected`; any `uncertain` attempt, or no evidence
 * at all, is false. Fail-safe by construction: a record site that forgets to pass
 * its evidence, or mis-folds it into an empty list, can only record a request as
 * BILLED — today's behavior — never wrongly zero it. A genuine no-attempt walk is
 * never empty evidence, because the chain walkers stamp it `not_sent`.
 */
export function walkUnbilled(classes: readonly AttemptBilling[] | undefined): boolean {
  if (classes === undefined || classes.length === 0) return false;
  return classes.every((c) => c === 'not_sent' || c === 'rejected');
}
