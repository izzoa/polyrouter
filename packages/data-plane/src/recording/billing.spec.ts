import { walkUnbilled } from './billing';
import { chainBillingEvidence, type AttemptBilling } from '../proxy/core';
import { ProviderError } from '../providers';
import * as dataPlane from '../index';

describe('walkUnbilled (zero-cost-unbilled-errors, design D2)', () => {
  // Fail-safe: no evidence can only mean "billed as today". A record site that forgets
  // its evidence, or folds an empty list, must never zero a request.
  it('is false for empty or missing evidence', () => {
    expect(walkUnbilled([])).toBe(false);
    expect(walkUnbilled(undefined)).toBe(false);
  });

  it.each<[string, readonly AttemptBilling[]]>([
    ['one not_sent', ['not_sent']],
    ['one rejected', ['rejected']],
    ['all not_sent', ['not_sent', 'not_sent', 'not_sent']],
    ['all rejected', ['rejected', 'rejected']],
    [
      'an unequal not_sent/rejected mix',
      ['rejected', 'not_sent', 'rejected', 'not_sent', 'not_sent'],
    ],
  ])('is true for %s', (_name, classes) => {
    expect(walkUnbilled(classes)).toBe(true);
  });

  it('is false when any single attempt is uncertain', () => {
    expect(walkUnbilled(['uncertain'])).toBe(false);
    // The uncertain member at every position of an otherwise all-unbilled walk.
    const clean: AttemptBilling[] = ['rejected', 'not_sent', 'rejected', 'not_sent'];
    for (let i = 0; i < clean.length; i += 1) {
      const walk = clean.map((c, j): AttemptBilling => (j === i ? 'uncertain' : c));
      expect(walkUnbilled(walk)).toBe(false);
    }
  });

  it('does not mutate its input', () => {
    const classes: AttemptBilling[] = ['rejected', 'not_sent'];
    walkUnbilled(classes);
    expect(classes).toEqual(['rejected', 'not_sent']);
  });

  // The fold a record site actually performs: core's evidence in, one boolean out.
  it('folds a chain result the way the proxy does', () => {
    const failure = (billing: AttemptBilling) => ({
      index: 0,
      error: new ProviderError('unavailable', 'x'),
      billing,
    });
    // An exhausted walk of dispatched attempts carries no terminal evidence.
    expect(
      walkUnbilled(chainBillingEvidence({ failures: [failure('rejected'), failure('not_sent')] })),
    ).toBe(true);
    // A non-retryable stop adds its own class.
    expect(
      walkUnbilled(
        chainBillingEvidence({ failures: [failure('rejected')], terminalBilling: 'uncertain' }),
      ),
    ).toBe(false);
    // A genuine no-attempt walk is stamped by core, so it is never empty evidence.
    expect(walkUnbilled(chainBillingEvidence({ failures: [], terminalBilling: 'not_sent' }))).toBe(
      true,
    );
    // A walk with neither failures nor terminal evidence is empty — billed.
    expect(walkUnbilled(chainBillingEvidence({ failures: [] }))).toBe(false);
  });
});

// The control plane imports these from the package root (its dist), so the barrel
// must carry every name the proxy sites need.
describe('package index exports the billing evidence surface', () => {
  it('exposes attemptBilling, chainBillingEvidence and walkUnbilled', () => {
    expect(typeof dataPlane.attemptBilling).toBe('function');
    expect(typeof dataPlane.chainBillingEvidence).toBe('function');
    expect(typeof dataPlane.walkUnbilled).toBe('function');
    const sample: dataPlane.AttemptBilling = 'not_sent'; // the type is exported too
    expect(walkUnbilled([sample])).toBe(true);
  });
});
