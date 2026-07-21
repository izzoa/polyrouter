import { userPrincipal } from '@polyrouter/shared/server';
import type { RecordOutcome } from '../recording/request-recorder';
import type { EvidenceAccumulator } from './evidence-accumulator';
import { SemanticLearningContributor } from './semantic-learning-contributor';
import type { SemanticConfig } from './semantic.config';

/** The label→accumulate dispatch of the recorder's learning sink (task 3.3). */

const vec = new Float32Array([1, 2, 3]);
const CFG = {
  learning: { minCohort: 8, maxCohorts: 4096, stateTtlD: 30 },
} as unknown as SemanticConfig;

function make(): { contributor: SemanticLearningContributor; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const accumulator = {
    tenantHmac: (id: string) => `hmac-${id}`,
    contribute: (...args: unknown[]) => calls.push(args),
  } as unknown as EvidenceAccumulator;
  return { contributor: new SemanticLearningContributor(accumulator, CFG), calls };
}

const outcome = (o: Partial<RecordOutcome>): RecordOutcome => ({
  status: 'success',
  outputChars: 0,
  ...o,
});

describe('SemanticLearningContributor', () => {
  it('a quality-passed cheap answer contributes a LOW sample', () => {
    const { contributor, calls } = make();
    contributor.contribute(
      userPrincipal('u1'),
      0,
      vec,
      'rev1',
      outcome({ status: 'success', escalated: false, qualitySignal: 0.9 }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      'hmac-u1',
      0,
      'low',
      'rev1',
      vec,
      { minCohort: 8, maxCohorts: 4096, ttlSeconds: 30 * 86_400 },
    ]);
  });

  it('a quality-gate escalation contributes a HIGH sample', () => {
    const { contributor, calls } = make();
    contributor.contribute(
      userPrincipal('u1'),
      0,
      vec,
      'rev1',
      outcome({ escalated: true, escalationSource: 'quality_gate' }),
    );
    expect(calls[0]?.[2]).toBe('high'); // arg[2] = label (arg[1] = epoch)
  });

  it('every other outcome contributes NOTHING', () => {
    const { contributor, calls } = make();
    // cheap_error escalation
    contributor.contribute(
      userPrincipal('u'),
      0,
      vec,
      'r',
      outcome({ escalated: true, escalationSource: 'cheap_error' }),
    );
    // cancellation
    contributor.contribute(
      userPrincipal('u'),
      0,
      vec,
      'r',
      outcome({ status: 'cancelled', escalated: false, qualitySignal: null }),
    );
    // fail-open unknown quality (null signal, not escalated)
    contributor.contribute(
      userPrincipal('u'),
      0,
      vec,
      'r',
      outcome({ status: 'success', escalated: false, qualitySignal: null }),
    );
    expect(calls).toHaveLength(0);
  });
});
