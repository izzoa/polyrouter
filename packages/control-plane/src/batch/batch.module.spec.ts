/**
 * Module-graph guards for the batch modules (add-batch-inference).
 *
 * These exist because a Nest wiring mistake is invisible to every test that builds its
 * own module: the batch e2e harness declares `BATCH_CONFIG`/`BATCH_RUNTIME`/
 * `BATCH_ADAPTER_FACTORY` itself, so 46 e2e tests passed against a graph the production
 * server could not construct — `BatchModule` provided `BATCH_CONFIG` without exporting
 * it, and `BatchPoller` injects it from `BatchPollerModule`. `prod-topology.e2e-spec.ts`
 * caught it, three minutes into the run. This catches it in milliseconds.
 */
import 'reflect-metadata';
import { BATCH_CONFIG } from './batch.config';
import { BatchModule } from './batch.module';
import { BatchPollerModule } from './batch-poller.module';
import { BatchPoller } from './batch.poller';
import { BatchService } from './batch.service';

const exportsOf = (m: unknown): unknown[] =>
  (Reflect.getMetadata('exports', m as object) as unknown[] | undefined) ?? [];
const importsOf = (m: unknown): unknown[] =>
  (Reflect.getMetadata('imports', m as object) as unknown[] | undefined) ?? [];

describe('batch module wiring', () => {
  it('exports every token another module injects', () => {
    // `BatchPoller`'s constructor is the authority on what has to cross the boundary.
    const params =
      (Reflect.getMetadata('self:paramtypes', BatchPoller) as
        { index: number; param: unknown }[] | undefined) ?? [];
    const injected = params.map((p) => p.param);
    expect(injected).toContain(BATCH_CONFIG);
    expect(importsOf(BatchPollerModule)).toContain(BatchModule);
    expect(exportsOf(BatchModule)).toContain(BATCH_CONFIG);
  });

  it('keeps the poller controller-free, so it may hold the maintenance half', () => {
    // D19's module boundary: a request-handling module reads persistence through the
    // scoped port only. The poller is allowed the maintenance accessor precisely because
    // it serves no request.
    expect(Reflect.getMetadata('controllers', BatchPollerModule) ?? []).toEqual([]);
  });
});

describe('the servicing seam is selected by purpose (add-batch-mode-routing task 1.2)', () => {
  /**
   * `batchFor` serves an ALREADY-ACCEPTED job — the poller, cancel, and results.
   * It must ask the factory for the SERVICING predicate, because
   * `createProviderAdapter` otherwise applies the submission one and a narrowing
   * there would strip the seam from a live job: the poller releases nothing on a
   * failure, so the job would never terminate, its reservation would stand for the
   * rest of its budget window, and its paid-for results would be unreadable.
   *
   * Asserted here rather than end-to-end: the e2e fixture cannot exist. A
   * subscription provider at the loopback stub is refused by the SSRF guard before
   * any seam is consulted, because loopback is legal only for `kind: 'local'`
   * (invariant 6). The predicate split itself is covered in
   * `data-plane/src/providers/factory.spec.ts`.
   */
  it('asks for the servicing predicate, and never rewrites the provider kind', async () => {
    const calls: { kind: string; purpose: string | undefined }[] = [];
    const svc = Object.create(BatchService.prototype) as BatchService;
    const config = {
      kind: 'local',
      baseUrl: 'http://127.0.0.1:1/or',
      protocol: 'openai_compatible',
    };
    Object.assign(svc, {
      builder: { buildConfig: () => Promise.resolve(config) },
      rt: { firstByteTimeoutMs: 1, idleTimeoutMs: 1, streamEventTimeoutMs: 1 },
      factory: (cfg: { kind: string }, deps: { batchPurpose?: string } = {}) => {
        calls.push({ kind: cfg.kind, purpose: deps.batchPurpose });
        return { batch: {} };
      },
    });
    await svc.batchFor({ userId: 'u', orgId: null } as never, { id: 'p' } as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.purpose).toBe('servicing');
    // The live row stays the truth for HOW to reach the provider: `kind` also drives
    // connect-time SSRF and credential resolution, so rewriting it to a job's
    // recorded value would change semantics far beyond the batch seam.
    expect(calls[0]!.kind).toBe('local');
  });
});
