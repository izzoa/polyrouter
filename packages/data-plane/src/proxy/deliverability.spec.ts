// honest-model-capabilities — the four-group deliverability ordering, composing
// capability-shortness with the output-cap deferral as ONE stable sort.
//
// The governing rules, all asserted below: capability outranks capacity (a
// clamped answer is real, a capability rejection is nothing); unknown NEVER
// defers (invariant 1); no member is ever discarded; and a request that demands
// no capability reduces byte-identically to the pre-existing cap plan.
import {
  capabilityDemandOf,
  planDeliverability,
  planOutputCaps,
  type CapPlanInput,
} from './output-caps';

// Pairing fence: the "member" carries its OWN meta so a reorder that split
// parallel arrays would be visible as a label/meta mismatch.
interface Paired {
  readonly id: string;
  readonly meta: { readonly forId: string };
}
const m = (
  id: string,
  cap: number | null | undefined,
  capabilityShort: readonly string[] = [],
): CapPlanInput<Paired> => ({
  member: { id, meta: { forId: id } },
  cap,
  label: id,
  capabilityShort,
});
const order = (plan: { members: readonly { member: Paired }[] }): string[] =>
  plan.members.map((p) => p.member.id);
const clamps = (plan: { members: readonly { member: Paired; clampTo?: number }[] }) =>
  plan.members.filter((p) => p.clampTo !== undefined).map((p) => [p.member.id, p.clampTo]);

describe('planDeliverability — the four groups', () => {
  it('orders capable-first, then clamped, then short, then short-and-clamped', () => {
    const plan = planDeliverability(
      [
        m('g4', 4_096, ['vision']), // short AND cap-short
        m('g3', 200_000, ['vision']), // short, cap fine
        m('g2', 4_096), // capable, cap-short
        m('g1', 200_000), // capable, cap fine
      ],
      100_000,
    );
    expect(order(plan)).toEqual(['g1', 'g2', 'g3', 'g4']);
    // Only the cap-short members are clamped, each to its OWN cap.
    expect(clamps(plan)).toEqual([
      ['g2', 4_096],
      ['g4', 4_096],
    ]);
  });

  it('keeps the configured order INSIDE each group (a stable sort)', () => {
    const plan = planDeliverability(
      [m('a', null), m('b', null, ['tools']), m('c', null), m('d', null, ['tools'])],
      undefined,
    );
    // a,c keep their relative order; b,d keep theirs.
    expect(order(plan)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('prefers a member that can answer BRIEFLY over one that cannot answer', () => {
    // The whole reason capability outranks capacity: A truncates honestly through
    // the protocol's `length` stop reason; B rejects the request outright.
    const plan = planDeliverability([m('A', 4_096), m('B', 200_000, ['vision'])], 100_000);
    expect(order(plan)).toEqual(['A', 'B']);
    expect(clamps(plan)).toEqual([['A', 4_096]]);
  });
});

describe('planDeliverability — unknown never defers', () => {
  it('leaves a member with no capability evidence exactly where it was', () => {
    const plan = planDeliverability([m('unknown', null), m('capable', null)], undefined);
    expect(order(plan)).toEqual(['unknown', 'capable']);
    expect(plan.planned).toBe(false); // nothing to plan at all
    expect(plan.capabilityDeferred).toEqual([]);
  });

  it('defers only the member the catalog states a negative for', () => {
    const plan = planDeliverability(
      [m('silent', null), m('denies', null, ['vision']), m('affirms', null)],
      undefined,
    );
    expect(order(plan)).toEqual(['silent', 'affirms', 'denies']);
    expect(plan.capabilityDeferred).toEqual([{ label: 'denies', capabilities: ['vision'] }]);
  });
});

describe('planDeliverability — no member is discarded', () => {
  it('dispatches an all-short chain in CONFIGURED order, deferring nothing', () => {
    const plan = planDeliverability(
      [m('x', null, ['vision']), m('y', null, ['vision'])],
      undefined,
    );
    expect(order(plan)).toEqual(['x', 'y']); // configured order, untouched
    expect(plan.members).toHaveLength(2); // nothing filtered out
    // Nothing was deferred BEHIND anything — the leading group is simply empty.
    expect(plan.capabilityDeferred).toEqual([]);
  });

  it('reports every short member when at least one is not short', () => {
    const plan = planDeliverability(
      [m('p', null, ['vision', 'tools']), m('q', null), m('r', null, ['tools'])],
      undefined,
    );
    expect(plan.capabilityDeferred).toEqual([
      { label: 'p', capabilities: ['vision', 'tools'] },
      { label: 'r', capabilities: ['tools'] },
    ]);
  });
});

describe('planDeliverability — reduction to the cap plan', () => {
  const chain = [m('A', 16_384), m('B', 200_000), m('C', null)];

  it('is byte-identical to planOutputCaps when no capability is demanded', () => {
    for (const ask of [100_000, 1, undefined, 0, -5, 1.5, NaN, 'x']) {
      expect(planDeliverability(chain, ask)).toEqual(planOutputCaps(chain, ask));
    }
  });

  it('is byte-identical when a capability is demanded but no member is short', () => {
    const none = chain.map((c) => ({ ...c, capabilityShort: [] }));
    expect(planDeliverability(none, 100_000)).toEqual(planOutputCaps(chain, 100_000));
  });

  it('preserves the strict cap boundary and the participation domain', () => {
    // cap == ask is NOT short (strictly `cap < requested`).
    expect(order(planDeliverability([m('EQ', 100_000), m('LOW', 99_999)], 100_000))).toEqual([
      'EQ',
      'LOW',
    ]);
    // A non-participating ask cannot make a member cap-short, even alongside a
    // capability demand that does trigger planning.
    const plan = planDeliverability([m('tiny', 16), m('short', null, ['vision'])], 0);
    expect(clamps(plan)).toEqual([]);
    expect(order(plan)).toEqual(['tiny', 'short']);
  });
});

describe('capabilityDemandOf — the request side', () => {
  const text = (s: string) => ({ type: 'text' as const, text: s });
  const image = { type: 'image' as const, url: 'https://x/y.png' };

  it('demands nothing from a plain text request', () => {
    expect(capabilityDemandOf({ messages: [{ content: [text('hi')] }] })).toEqual([]);
  });

  it('demands tools when the request defines any, and not for an empty list', () => {
    const msgs = [{ content: [text('hi')] }];
    expect(capabilityDemandOf({ messages: msgs, tools: [{ name: 't' }] })).toEqual(['tools']);
    expect(capabilityDemandOf({ messages: msgs, tools: [] })).toEqual([]);
  });

  it('demands vision for an image anywhere — including inside a tool result', () => {
    expect(capabilityDemandOf({ messages: [{ content: [text('a'), image] }] })).toEqual(['vision']);
    // An image RETURNED by a tool is still an image the next model must read.
    expect(
      capabilityDemandOf({
        messages: [
          {
            content: [
              { type: 'tool_result' as const, toolUseId: 'u1', content: [text('t'), image] },
            ],
          },
        ],
      }),
    ).toEqual(['vision']);
    // …and in the system blocks.
    expect(capabilityDemandOf({ system: [image], messages: [{ content: [text('a')] }] })).toEqual([
      'vision',
    ]);
  });

  it('never demands reasoning, however the request is shaped', () => {
    const demands = capabilityDemandOf({
      messages: [{ content: [text('think hard'), image] }],
      tools: [{ name: 't' }],
    });
    // A reasoning control is an opaque passthrough already dropped across
    // protocols, so it has no well-defined truth value at the router.
    expect(demands).not.toContain('reasoning');
    expect([...demands].sort()).toEqual(['tools', 'vision']);
  });
});
