import { CentroidValidationError } from '@polyrouter/data-plane';
import { EmbedError } from './embed-core';
import { PhaseBudgetError, classifyBuildFailure } from './recovery-classify';
import { PhaseBudgetError as ReExported } from './semantic-classifier.service';

/**
 * recover-semantic-centroid-build. The whole recovery turns on this split, so
 * every arm is pinned — including the ones whose classification is a judgment
 * call rather than an obvious fact.
 */
describe('build-failure classification', () => {
  it('classifies the SAME PhaseBudgetError the phase runner throws', () => {
    // Two same-named classes would make every spent budget read as terminal,
    // silently disabling recovery for its commonest cause — and `instanceof`
    // fails silently, so nothing else would notice.
    expect(ReExported).toBe(PhaseBudgetError);
    expect(classifyBuildFailure(new ReExported('bundled', 20_000))).toBe('retryable');
  });

  it('treats a spent budget and a busy host as retryable', () => {
    expect(classifyBuildFailure(new PhaseBudgetError('bundled', 20_000))).toBe('retryable');
    expect(classifyBuildFailure(new EmbedError('timeout', 'slow'))).toBe('retryable');
    expect(classifyBuildFailure(new EmbedError('saturated', 'busy'))).toBe('retryable');
  });

  it('treats a degenerate result as terminal — retrying it is arithmetic that cannot differ', () => {
    expect(classifyBuildFailure(new CentroidValidationError('anchors do not separate'))).toBe(
      'terminal',
    );
  });

  it('treats a model-contract violation as terminal, not a busy host', () => {
    expect(classifyBuildFailure(new EmbedError('invalid_output', 'wrong shape'))).toBe('terminal');
  });

  it('treats `runtime` as terminal because it mixes deterministic setup faults with transient ones', () => {
    // A deliberate choice, not an oversight: until the kind is split, the
    // deterministic half governs — it is the half that must not be retried.
    expect(classifyBuildFailure(new EmbedError('runtime', 'inference failed'))).toBe('terminal');
  });

  it('never classifies a bare abort as retryable — cause decides that, at the call site', () => {
    expect(classifyBuildFailure(new EmbedError('aborted', 'aborted by caller'))).toBe('terminal');
  });

  it('defaults an unclassified fault to terminal — the safe direction', () => {
    // A wrong "retryable" spends slots on something deterministic and buries
    // the real error; a wrong "terminal" costs only an automatic recovery a
    // restart still provides.
    expect(classifyBuildFailure(new Error('something unexpected'))).toBe('terminal');
    expect(classifyBuildFailure('not even an error')).toBe('terminal');
    expect(classifyBuildFailure(undefined)).toBe('terminal');
  });
});
