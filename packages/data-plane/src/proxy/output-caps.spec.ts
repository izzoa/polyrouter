import { planOutputCaps, participatingAsk, type CapPlanInput } from './output-caps';

// Pairing fence: the "member" carries its OWN meta so a reorder that split
// parallel arrays would be visible as a label/meta mismatch.
interface Paired {
  readonly id: string;
  readonly meta: { readonly forId: string };
}
const m = (id: string, cap: number | null | undefined): CapPlanInput<Paired> => ({
  member: { id, meta: { forId: id } },
  cap,
  label: id,
});
const order = <T extends Paired>(plan: { members: readonly { member: T }[] }): string[] =>
  plan.members.map((p) => p.member.id);

describe('planOutputCaps — two-stage deferral (add-output-cap-guardrails)', () => {
  it('defers a known-insufficient member behind the capable one; clamp on the tail only', () => {
    const plan = planOutputCaps([m('A', 16_384), m('B', 200_000)], 100_000);
    expect(plan.planned).toBe(true);
    expect(order(plan)).toEqual(['B', 'A']);
    expect(plan.members[0]!.clampTo).toBeUndefined();
    expect(plan.members[1]!.clampTo).toBe(16_384);
    expect(plan.deferred).toEqual([{ label: 'A', cap: 16_384 }]);
  });

  it('an empty head walks the tail in CONFIGURED order, each clamped to its OWN cap, no deferrals', () => {
    const plan = planOutputCaps([m('A', 4_096), m('B', 16_384)], 100_000);
    expect(order(plan)).toEqual(['A', 'B']); // configured order, NOT cap-descending
    expect(plan.members.map((p) => p.clampTo)).toEqual([4_096, 16_384]);
    expect(plan.deferred).toEqual([]); // nothing was deferred behind anything
  });

  it('cap == ask is head-eligible (strict <); unknown never defers', () => {
    const plan = planOutputCaps([m('EQ', 100_000), m('U', null), m('LOW', 99_999)], 100_000);
    expect(order(plan)).toEqual(['EQ', 'U', 'LOW']);
    expect(plan.members[2]!.clampTo).toBe(99_999);
    expect(plan.deferred).toEqual([{ label: 'LOW', cap: 99_999 }]);
  });

  it('preserves configured relative order WITHIN each stage', () => {
    const plan = planOutputCaps(
      [m('t1', 8_192), m('h1', null), m('t2', 4_096), m('h2', 200_000)],
      100_000,
    );
    expect(order(plan)).toEqual(['h1', 'h2', 't1', 't2']);
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity, -Infinity, '100000', undefined, null, {}])(
    'non-participating ask %p → identity plan, no reasons',
    (ask) => {
      const plan = planOutputCaps([m('A', 16), m('B', null)], ask);
      expect(plan.planned).toBe(false);
      expect(order(plan)).toEqual(['A', 'B']);
      expect(plan.members.every((p) => p.clampTo === undefined)).toBe(true);
      expect(plan.deferred).toEqual([]);
    },
  );

  it('an invalid CAP (fractional/non-positive) is treated as unknown, never clamped', () => {
    const plan = planOutputCaps([m('frac', 1.5), m('zero', 0), m('neg', -5)], 100);
    expect(order(plan)).toEqual(['frac', 'zero', 'neg']);
    expect(plan.members.every((p) => p.clampTo === undefined)).toBe(true);
  });

  it('single-member chains: capable stays verbatim; insufficient becomes a one-member clamped tail', () => {
    expect(planOutputCaps([m('big', 200_000)], 100_000).members[0]!.clampTo).toBeUndefined();
    const clamped = planOutputCaps([m('small', 8_192)], 100_000);
    expect(clamped.members[0]!.clampTo).toBe(8_192);
    expect(clamped.deferred).toEqual([]); // empty head — a clamp, not a deferral
  });

  it('meta stays paired with its attempt after a reorder (atomicity fence)', () => {
    const plan = planOutputCaps([m('A', 8), m('B', null), m('C', 4)], 100);
    for (const p of plan.members) expect(p.member.meta.forId).toBe(p.member.id);
    expect(order(plan)).toEqual(['B', 'A', 'C']);
  });

  it('participatingAsk pins the domain', () => {
    expect(participatingAsk(1)).toBe(1);
    expect(participatingAsk(100_000)).toBe(100_000);
    for (const bad of [0, -1, 0.5, Number.NaN, Infinity, -Infinity, '5', null, undefined]) {
      expect(participatingAsk(bad)).toBeNull();
    }
  });
});
