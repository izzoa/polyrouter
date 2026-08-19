/**
 * Output-cap capacity planning (add-output-cap-guardrails) — the pure two-stage
 * deferral over one WALKED chain. Members whose KNOWN cap cannot satisfy the
 * request's `maxOutputTokens` are deferred behind the members that can (or
 * might — unknown caps never defer, invariant 1), each tail member clamped to
 * its OWN cap at dispatch. Within each stage the input (configured) order
 * holds: capacity determines the stage, configuration the order inside it.
 *
 * Generic over the member type so the caller's attempt+meta pairing reorders
 * ATOMICALLY — the planner never sees (and can never split) parallel arrays.
 */

export interface CapPlanInput<T> {
  readonly member: T;
  /** The member's KNOWN output cap (exact catalog key only), or null/undefined = unknown. */
  readonly cap: number | null | undefined;
  /** Display label for recorded reasons (the external model id). */
  readonly label: string;
}

export interface CapPlannedMember<T> {
  readonly member: T;
  readonly label: string;
  /** Set ONLY for tail members: dispatch with `maxOutputTokens` clamped to this. */
  readonly clampTo?: number;
}

export interface CapPlan<T> {
  /** False = the participation guard declined (no valid ask): identity order, no reasons. */
  readonly planned: boolean;
  /** The effective walk order: head (capable/unknown) then tail (clamped). */
  readonly members: readonly CapPlannedMember<T>[];
  /** Tail members that were deferred BEHIND a non-empty head (an empty head is
   * the all-insufficient case — nothing was deferred behind anything; only the
   * clamps record). */
  readonly deferred: readonly { readonly label: string; readonly cap: number }[];
}

/** A cap participates only as a positive integer; anything else is unknown. */
function knownCap(cap: number | null | undefined): number | null {
  return typeof cap === 'number' && Number.isInteger(cap) && cap > 0 ? cap : null;
}

/** The ask participates only as a positive finite integer (`NaN`, infinities,
 * fractions, non-numbers, zero, negatives all excluded) — any other value
 * routes byte-identically to an ask-less request. */
export function participatingAsk(ask: unknown): number | null {
  return typeof ask === 'number' && Number.isInteger(ask) && ask > 0 ? ask : null;
}

export function planOutputCaps<T>(members: readonly CapPlanInput<T>[], ask: unknown): CapPlan<T> {
  const wanted = participatingAsk(ask);
  if (wanted === null) {
    return {
      planned: false,
      members: members.map((m) => ({ member: m.member, label: m.label })),
      deferred: [],
    };
  }
  const head: CapPlannedMember<T>[] = [];
  const tail: CapPlannedMember<T>[] = [];
  const tailInfo: { label: string; cap: number }[] = [];
  for (const m of members) {
    const cap = knownCap(m.cap);
    // Strict `<`: cap == ask is head-eligible; unknown never defers.
    if (cap !== null && cap < wanted) {
      tail.push({ member: m.member, label: m.label, clampTo: cap });
      tailInfo.push({ label: m.label, cap });
    } else {
      head.push({ member: m.member, label: m.label });
    }
  }
  return {
    planned: true,
    members: [...head, ...tail],
    deferred: head.length > 0 ? tailInfo : [],
  };
}
