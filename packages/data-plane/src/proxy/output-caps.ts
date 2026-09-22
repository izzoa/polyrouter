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
import type { ContentBlock } from './translate';

export interface CapPlanInput<T> {
  readonly member: T;
  /** The member's KNOWN output cap (exact catalog key only), or null/undefined = unknown. */
  readonly cap: number | null | undefined;
  /** Display label for recorded reasons (the external model id). */
  readonly label: string;
  /**
   * The demanded capabilities this member is KNOWN to lack (honest-model-capabilities).
   * Empty or absent = nothing known against it, which INCLUDES "unknown": a member
   * whose capability no catalog row states keeps its configured position, because
   * deferring on silence would reorder most tenants' chains on an annotation nobody
   * wrote (invariant 1). Evidence comes from the EXACT catalog key only — never the
   * native-family row or the provider's own claim, both of which are estimates that
   * must not demote a member below the order its owner configured.
   */
  readonly capabilityShort?: readonly string[];
}

export interface CapPlannedMember<T> {
  readonly member: T;
  readonly label: string;
  /** Set ONLY for tail members: dispatch with `maxOutputTokens` clamped to this. */
  readonly clampTo?: number;
}

export interface CapPlan<T> {
  /** False = nothing to plan (no valid ask AND no known-short member): identity
   * order, no reasons. */
  readonly planned: boolean;
  /** The effective walk order: the four groups below, in order. */
  readonly members: readonly CapPlannedMember<T>[];
  /** Members deferred for CAPACITY behind at least one member that was not (an
   * all-insufficient chain deferred nothing behind anything; only the clamps
   * record). */
  readonly deferred: readonly { readonly label: string; readonly cap: number }[];
  /** Members deferred for CAPABILITY, on the same "behind something" rule
   * (honest-model-capabilities). */
  readonly capabilityDeferred: readonly {
    readonly label: string;
    readonly capabilities: readonly string[];
  }[];
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

/**
 * The deliverability plan over one WALKED chain: a STABLE ordering on the pair
 * *(known-short on a demanded capability, known-insufficient output cap)*,
 * ascending, preserving the configured relative order inside each group:
 *
 *   group 1  (false, false)   capable/unknown, cap ok/unknown   -> verbatim
 *   group 2  (false, true )   capable/unknown, cap short        -> clamped
 *   group 3  (true , false)   KNOWN-SHORT,     cap ok/unknown   -> verbatim
 *   group 4  (true , true )   KNOWN-SHORT,     cap short        -> clamped
 *
 * Capability outranks capacity because the two degrade differently: a clamped
 * dispatch returns a real answer, truncated honestly through the protocol's
 * `length` stop reason, whereas a capability-short dispatch returns no answer at
 * all. A member that can answer briefly is preferred over one that cannot answer.
 *
 * ONE ordering, not two passes. A second pass over the first's output would
 * desynchronize the caller's clamp strings (which are keyed by EFFECTIVE index)
 * and could move a clamped member ahead of an unclamped one — an ordering neither
 * requirement specifies.
 *
 * No member is ever discarded: a known-short member stays available as a degraded
 * fallback, and a chain whose every member is short simply has an empty leading
 * group and dispatches in configured order (invariant 1).
 */
export function planDeliverability<T>(
  members: readonly CapPlanInput<T>[],
  ask: unknown,
): CapPlan<T> {
  const wanted = participatingAsk(ask);
  const rows = members.map((m, index) => {
    const cap = knownCap(m.cap);
    const missing = m.capabilityShort ?? [];
    return {
      index,
      member: m.member,
      label: m.label,
      cap,
      // Strict `<`: cap == ask is not short; an unknown cap is never short.
      capShort: wanted !== null && cap !== null && cap < wanted,
      missing,
      capabilityShort: missing.length > 0,
    };
  });

  // Nothing to plan: no participating ask AND nothing known against any member.
  // Identity order, no reasons — byte-identical to the pre-change behaviour.
  if (wanted === null && !rows.some((r) => r.capabilityShort)) {
    return {
      planned: false,
      members: members.map((m) => ({ member: m.member, label: m.label })),
      deferred: [],
      capabilityDeferred: [],
    };
  }

  const group = (r: (typeof rows)[number]): number =>
    (r.capabilityShort ? 2 : 0) + (r.capShort ? 1 : 0);
  const ordered = [...rows].sort((a, b) => group(a) - group(b) || a.index - b.index);

  return {
    planned: true,
    members: ordered.map((r) => ({
      member: r.member,
      label: r.label,
      // Only a cap-short member is clamped, and always to its OWN cap.
      ...(r.capShort && r.cap !== null ? { clampTo: r.cap } : {}),
    })),
    // A deferral is only reported when the member was deferred BEHIND something:
    // an all-short chain deferred nothing relative to anything.
    deferred: rows.some((r) => !r.capShort)
      ? rows.filter((r) => r.capShort).map((r) => ({ label: r.label, cap: r.cap! }))
      : [],
    capabilityDeferred: rows.some((r) => !r.capabilityShort)
      ? rows
          .filter((r) => r.capabilityShort)
          .map((r) => ({ label: r.label, capabilities: r.missing }))
      : [],
  };
}

/**
 * The capacity-only plan (add-output-cap-guardrails), unchanged in behaviour.
 * Retained as the narrow entry point and expressed as the general plan with no
 * capability demand — which is exactly the reduction the contract promises: where
 * a request demands no capability, deliverability IS the output-cap plan.
 */
export function planOutputCaps<T>(members: readonly CapPlanInput<T>[], ask: unknown): CapPlan<T> {
  return planDeliverability(
    members.map((m) => ({ member: m.member, cap: m.cap, label: m.label })),
    ask,
  );
}

/**
 * The capabilities a request DEMANDS, read from the normalized request the router
 * already holds (honest-model-capabilities). Nothing here inspects a raw wire
 * body, a provider response, or message text: the demand is structural.
 *
 * Exactly two capabilities participate:
 *   - `vision`, when any content block anywhere in the request is an image;
 *   - `tools`, when the request defines at least one tool.
 *
 * `reasoning` deliberately does NOT participate. A reasoning control is an
 * opaque, source-tagged passthrough that the translator already drops when it
 * crosses protocols, so "this request requires reasoning" has no well-defined
 * truth value at the router. It is still resolved and DESCRIBED on the read
 * surfaces; it simply defers no member.
 */
export function capabilityDemandOf(ir: {
  readonly system?: readonly ContentBlock[];
  readonly messages: readonly { readonly content: readonly ContentBlock[] }[];
  readonly tools?: readonly unknown[];
}): readonly string[] {
  const demands: string[] = [];
  if ((ir.tools?.length ?? 0) > 0) demands.push('tools');
  const blocks = [...(ir.system ?? []), ...ir.messages.flatMap((m) => m.content)];
  if (containsImage(blocks)) demands.push('vision');
  return demands;
}

/** Depth-bounded image search. A tool result carries nested content, so an image
 * returned by a tool is still an image the next model has to read. */
function containsImage(blocks: readonly ContentBlock[], depth = 0): boolean {
  if (depth > 4) return false; // structural guard; real nesting is 1 level
  for (const b of blocks) {
    if (b.type === 'image') return true;
    if (b.type === 'tool_result' && containsImage(b.content, depth + 1)) return true;
  }
  return false;
}
