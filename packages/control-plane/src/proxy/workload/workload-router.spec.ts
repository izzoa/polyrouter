import type { RouteRule, RoutingSnapshot, WorkloadVerdict } from '@polyrouter/data-plane';
import { WorkloadRouter } from './workload-router';

function rule(id: string, cls: string, target: string, priority = 0): RouteRule {
  return {
    id,
    matchType: 'auto_workload',
    headerName: 'x-polyrouter-tier',
    headerValue: null,
    workloadClass: cls,
    target,
    priority,
    createdAt: new Date(0),
  };
}
function snapshot(
  rules: RouteRule[],
  entries?: Map<string, { modelId: string; position: number }[]>,
): RoutingSnapshot {
  return {
    tiers: [
      { id: 't-code', key: 'coding' },
      { id: 't-empty', key: 'empty' },
    ],
    entriesByTierId:
      entries ??
      new Map([
        [
          't-code',
          [
            { modelId: 'm-code', position: 0 },
            { modelId: 'm-fb', position: 1 },
          ],
        ],
        ['t-empty', []],
      ]),
    rules,
    models: [
      { id: 'm-code', providerId: 'p1', externalModelId: 'coder' },
      { id: 'm-fb', providerId: 'p1', externalModelId: 'fallback' },
    ],
  };
}
// The union (add-semantic-workloads): a reserved class can only come from the
// semantic source; everything else here is structural.
const verdict = (
  cls: WorkloadVerdict['class'],
  reason = `workload:${cls} score=1.00`,
): WorkloadVerdict =>
  cls === 'research' || cls === 'writing'
    ? { class: cls, score: 1, source: 'semantic', revision: 'semantic/v1/s1/000000000000', reason }
    : {
        class: cls,
        score: cls === 'none' ? 0 : 1,
        source: 'structural',
        revision: 'structural/v1/c1/000000000000',
        reason,
      };

describe('WorkloadRouter.claim (add-workload-routing)', () => {
  const r = new WorkloadRouter();

  it('claims a tier target with the chain, layer workload, and the verdict reason', () => {
    const d = r.claim(
      snapshot([rule('w', 'code', 'tier:coding')]),
      verdict('code', 'workload:code score=0.40 share=0.40 codechars=800 mm=0 rf=0'),
    );
    expect(d).toMatchObject({
      decisionLayer: 'workload',
      tierKey: 'coding',
      modelId: 'm-code',
      routingReason: 'workload:code score=0.40 share=0.40 codechars=800 mm=0 rf=0',
    });
    expect(d!.chain).toHaveLength(2);
  });

  it('claims a model target as the single model', () => {
    const d = r.claim(snapshot([rule('w', 'vision', 'model:m-fb')]), verdict('vision'));
    expect(d).toMatchObject({ decisionLayer: 'workload', modelId: 'm-fb', tierKey: null });
    expect(d!.chain).toHaveLength(1);
  });

  it('returns null for none (whatever rules exist), no rule, an unresolved target, and an empty tier', () => {
    expect(r.claim(snapshot([rule('w', 'code', 'tier:coding')]), verdict('none'))).toBeNull();
    expect(r.claim(snapshot([]), verdict('code'))).toBeNull();
    expect(r.claim(snapshot([rule('w', 'vision', 'tier:coding')]), verdict('code'))).toBeNull(); // other class
    expect(r.claim(snapshot([rule('w', 'code', 'tier:ghost')]), verdict('code'))).toBeNull();
    expect(r.claim(snapshot([rule('w', 'code', 'tier:empty')]), verdict('code'))).toBeNull();
  });

  it('duplicates within a class resolve by priority (band-target discipline)', () => {
    const d = r.claim(
      snapshot([rule('low', 'code', 'tier:coding', 0), rule('high', 'code', 'model:m-fb', 5)]),
      verdict('code'),
    );
    expect(d).toMatchObject({ modelId: 'm-fb', tierKey: null });
  });
});
