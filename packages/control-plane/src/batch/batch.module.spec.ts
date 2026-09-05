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
