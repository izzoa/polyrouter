import { PROVIDER_ERROR_KINDS } from '@polyrouter/data-plane';
import { BATCH_JOB_ERROR_KINDS } from '@polyrouter/shared';
import { BATCH_KIND_OF } from './batch-error-kind';

const PLAN_KINDS = ['quota_exhausted', 'risk_control', 'plan_entitlement', 'plan_inactive'];

// classify-plan-quota-errors design D12: the batch mirror gets a compile-time link, and the
// CHECK-constrained vocabulary stays unchanged (no migration).
describe('BATCH_KIND_OF', () => {
  it.each(PROVIDER_ERROR_KINDS)('%s maps into BATCH_JOB_ERROR_KINDS', (kind) => {
    expect(BATCH_JOB_ERROR_KINDS as readonly string[]).toContain(BATCH_KIND_OF[kind]);
  });

  it.each(PROVIDER_ERROR_KINDS.filter((k) => !PLAN_KINDS.includes(k)))(
    '%s (an existing kind) maps to itself',
    (kind) => {
      expect(BATCH_KIND_OF[kind]).toBe(kind);
    },
  );

  it.each(PLAN_KINDS)('the plan kind %s maps to upstream_rejected', (kind) => {
    expect(BATCH_KIND_OF[kind as keyof typeof BATCH_KIND_OF]).toBe('upstream_rejected');
  });

  it('covers exactly the provider taxonomy', () => {
    expect(Object.keys(BATCH_KIND_OF).sort()).toEqual([...PROVIDER_ERROR_KINDS].sort());
  });

  it('leaves the batch vocabulary (and so the CHECK) without the plan kinds', () => {
    for (const k of PLAN_KINDS) expect(BATCH_JOB_ERROR_KINDS as readonly string[]).not.toContain(k);
  });
});
