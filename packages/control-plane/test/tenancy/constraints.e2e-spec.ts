import type {
  BatchJobInsertInput,
  BatchJobsCursor,
  ModelRow,
  ProviderInsertInput,
  RequestLogInsertInput,
} from '@polyrouter/shared/server';
import { TenancyHarness, type TestPrincipal } from './harness';

/** The accessor's cursor is opaque to callers; the service decodes it (task 4.9).
 * Decoded here the same way so the walk can be asserted end to end. */
function decodeCursor(raw: string): BatchJobsCursor {
  const [t, submittedAt, id] = Buffer.from(raw, 'base64').toString('utf8').split('|');
  return { terminal: t === '1', submittedAt: submittedAt!, id: id! };
}

function logRow(over: Partial<RequestLogInsertInput> = {}): RequestLogInsertInput {
  return {
    id: crypto.randomUUID(),
    agentId: null,
    providerId: null,
    modelId: null,
    tierAssigned: null,
    decisionLayer: 'default',
    routingReason: 'default tier',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    inputPriceSnapshot: 2.5,
    outputPriceSnapshot: 10,
    cacheReadPriceSnapshot: null,
    cacheWritePriceSnapshot: null,
    priceVersionId: 'v1',
    usageEstimated: false,
    cost: 0.1,
    durationMs: 5,
    status: 'success',
    escalated: false,
    qualitySignal: null,
    ...over,
  };
}

/** Database-enforced constraints (database-schema DoD): the §7.4 five-total
 * cap survives NULLs, races, and out-of-range positions; catalog sync is
 * idempotent; default-tier provisioning is race-safe. */

let harness: TenancyHarness;
let owner: TestPrincipal;

beforeAll(async () => {
  harness = await TenancyHarness.create();
  owner = await harness.createTestPrincipal('constraints');
}, 60_000);

afterAll(async () => {
  await harness.cleanup();
});

const providerValues: ProviderInsertInput = {
  name: 'p',
  kind: 'api_key',
  protocol: 'openai_compatible',
};

async function makeModels(count: number): Promise<ModelRow[]> {
  const provider = await harness.port.providers.insert(owner.principal, providerValues);
  const rows: ModelRow[] = [];
  for (let i = 0; i < count; i++) {
    const row = await harness.port.models.createForProvider(owner.principal, provider.id, {
      externalModelId: `m-${String(i)}-${Math.random().toString(36).slice(2, 8)}`,
    });
    if (!row) throw new Error('model creation failed unexpectedly');
    rows.push(row);
  }
  return rows;
}

describe('schema constraints', () => {
  it('caps a tier at five models total — sixth, out-of-range, and NULL positions are rejected', async () => {
    const tier = await harness.port.tiers.insert(owner.principal, {
      key: `cap-${Math.random().toString(36).slice(2, 8)}`,
    });
    const models = await makeModels(7);
    for (let position = 0; position < 5; position++) {
      const entry = await harness.port.routingEntries.add(owner.principal, {
        tierId: tier.id,
        modelId: models[position]!.id,
        position,
      });
      expect(entry).not.toBeNull();
    }
    // sixth entry: every position 0–4 is taken (unique) and 5 is out of range (CHECK)
    await expect(
      harness.port.routingEntries.add(owner.principal, {
        tierId: tier.id,
        modelId: models[5]!.id,
        position: 5,
      }),
    ).rejects.toThrow();
    await expect(
      harness.port.routingEntries.add(owner.principal, {
        tierId: tier.id,
        modelId: models[5]!.id,
        position: 0,
      }),
    ).rejects.toThrow();
    // NULL position cannot sneak past the cap (NOT NULL column)
    await expect(
      harness.pool.query(
        'INSERT INTO routing_entry (id, tier_id, model_id, position) VALUES ($1, $2, $3, NULL)',
        [crypto.randomUUID(), tier.id, models[6]!.id],
      ),
    ).rejects.toThrow(/null/i);
  });

  it('holds the cap under concurrent inserts', async () => {
    const tier = await harness.port.tiers.insert(owner.principal, {
      key: `race-${Math.random().toString(36).slice(2, 8)}`,
    });
    const models = await makeModels(8);
    const attempts = await Promise.allSettled(
      models.map((m, i) =>
        harness.port.routingEntries.add(owner.principal, {
          tierId: tier.id,
          modelId: m.id,
          // eight racers over five legal slots — at most five can win
          position: i % 5,
        }),
      ),
    );
    const won = attempts.filter((a) => a.status === 'fulfilled' && a.value !== null).length;
    expect(won).toBeLessThanOrEqual(5);
    const entries = await harness.port.routingEntries.listForTier(owner.principal, tier.id);
    expect(entries.length).toBeLessThanOrEqual(5);
  });

  it('rejects duplicate (provider_id, external_model_id) pairs', async () => {
    const provider = await harness.port.providers.insert(owner.principal, providerValues);
    const first = await harness.port.models.createForProvider(owner.principal, provider.id, {
      externalModelId: 'dup-model',
    });
    expect(first).not.toBeNull();
    await expect(
      harness.port.models.createForProvider(owner.principal, provider.id, {
        externalModelId: 'dup-model',
      }),
    ).rejects.toThrow();
  });

  it('enforces the batch-tier pair on model_price: half or negative pairs are rejected by the database', async () => {
    // add-batch-inference: a half rate is never stored — the CHECK, not just the
    // service, refuses it, so no code path can smuggle one in.
    const base = {
      modelKey: `test:batch-pair-${Math.random().toString(36).slice(2, 8)}`,
      inputPricePer1m: 1,
      outputPricePer1m: 2,
      source: 'manual',
      validFrom: new Date('2030-01-01T00:00:00Z'),
    };
    await expect(
      harness.port.pricing.insertVersion({ ...base, batchInputPricePer1m: 0.5 }),
    ).rejects.toThrow();
    await expect(
      harness.port.pricing.insertVersion({
        ...base,
        batchInputPricePer1m: -1,
        batchOutputPricePer1m: 1,
      }),
    ).rejects.toThrow();
    const ok = await harness.port.pricing.insertVersion({
      ...base,
      batchInputPricePer1m: 0.5,
      batchOutputPricePer1m: 1,
    });
    expect(ok.batchInputPricePer1m).toBe(0.5);
    expect(ok.batchOutputPricePer1m).toBe(1);
  });

  it('ensureDefaultTier is idempotent and race-safe: exactly one default tier', async () => {
    const fresh = await harness.createTestPrincipal('default-tier');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => harness.port.ensureDefaultTier(fresh.principal)),
    );
    const ids = new Set(results.map((t) => t.id));
    expect(ids.size).toBe(1);
    const again = await harness.port.ensureDefaultTier(fresh.principal);
    expect(again.id).toBe(results[0]!.id);
    const rows = await harness.pool.query(
      `SELECT count(*)::int AS n FROM tier WHERE owner_user_id = $1 AND key = 'default'`,
      [fresh.userId],
    );
    expect(rows.rows[0].n).toBe(1);
  });
});

describe('requestLogs (#11 audit records)', () => {
  it('inserts a batch, reads owned rows, and hides other tenants', async () => {
    const other = await harness.createTestPrincipal('log-other');
    const a = logRow({ status: 'success' });
    const b = logRow({ status: 'error' });
    await harness.port.requestLogs.insertMany(owner.principal, [a, b]);

    const mine = await harness.port.requestLogs.list(owner.principal);
    expect(mine.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(await harness.port.requestLogs.findById(owner.principal, a.id)).not.toBeNull();

    // Cross-tenant: invisible by list and by id.
    expect(await harness.port.requestLogs.list(other.principal)).toHaveLength(0);
    expect(await harness.port.requestLogs.findById(other.principal, a.id)).toBeNull();
  });

  it('is idempotent on re-insert of the same id (retry-safe, no double count)', async () => {
    const fresh = await harness.createTestPrincipal('log-idem');
    const row = logRow();
    await harness.port.requestLogs.insertMany(fresh.principal, [row]);
    await harness.port.requestLogs.insertMany(fresh.principal, [row]); // retry
    const rows = await harness.port.requestLogs.list(fresh.principal);
    expect(rows).toHaveLength(1);
  });
});

describe('batch_job (add-batch-inference, task 2.1): metadata only, invariants in the database', () => {
  /** A complete, valid row through raw SQL — the accessor is not under test here,
   * the CHECKs are, so nothing above the database can pre-empt them. */
  /** Drizzle wraps a failed query (`Failed query: …` with the pg error as `cause`)
   * while `pool.query` throws the pg error itself — read both, so a CHECK is
   * asserted BY NAME whichever path raised it. */
  const violates = async (p: Promise<unknown>, constraint: string): Promise<void> => {
    const err: unknown = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    const text = [err, (err as { cause?: unknown }).cause]
      .map((e) => (e instanceof Error ? e.message : String(e)))
      .join('\n');
    expect(text).toMatch(new RegExp(constraint));
  };

  const insertJob = (over: Record<string, unknown> = {}): Promise<unknown> => {
    const row: Record<string, unknown> = {
      id: crypto.randomUUID(),
      owner_user_id: owner.userId,
      agent_id: 'agent-1',
      provider_id: 'prov-1',
      model_id: 'model-1',
      endpoint: '/v1/chat/completions',
      protocol: 'openai_compatible',
      status: 'submitting',
      item_count: 10,
      completed_count: 0,
      failed_count: 0,
      estimated_input_tokens: 1200,
      price_mode: 'batch',
      input_price_snapshot: 1.25,
      output_price_snapshot: 5,
      price_version_id: 'v1',
      price_source: 'bundled',
      reserved_ceiling_micros: 250_000,
      settled_cost_micros: null,
      completion_window_ms: 86_400_000,
      terminal_at: null,
      error_kind: null,
      ...over,
    };
    const cols = Object.keys(row);
    return harness.pool.query(
      `INSERT INTO batch_job (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols
        .map((_, i) => `$${String(i + 1)}`)
        .join(', ')})`,
      cols.map((c) => row[c]),
    );
  };

  it('accepts a complete row and rejects every CHECK violation by name', async () => {
    await expect(insertJob()).resolves.toBeDefined();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['status_valid', { status: 'done' }],
      ['endpoint_valid', { endpoint: '/v1/completions' }],
      ['protocol_valid', { protocol: 'grpc' }],
      ['item_count_positive', { item_count: 0 }],
      ['counts_bounded', { completed_count: -1 }],
      ['counts_bounded', { completed_count: 6, failed_count: 5 }], // 11 > 10
      ['estimated_tokens_nonneg', { estimated_input_tokens: -1 }],
      ['price_mode_valid', { price_mode: 'sync-ish' }],
      ['price_pair', { output_price_snapshot: null }], // half pair
      ['price_pair', { price_source: null }], // pair without provenance
      ['price_source_valid', { price_source: 'model' }], // batch never prices model-own
      ['price_source_valid', { price_source: 'local' }],
      ['reserved_nonneg', { reserved_ceiling_micros: -1 }],
      ['settled_nonneg', { settled_cost_micros: -1 }],
      ['completion_window_positive', { completion_window_ms: 0 }],
      ['error_kind_valid', { error_kind: 'exploded' }],
      ['terminal_at_pair', { status: 'completed', terminal_at: null }],
      ['terminal_at_pair', { status: 'in_progress', terminal_at: new Date() }],
    ];
    for (const [name, over] of cases) {
      await violates(insertJob(over), `batch_job_${name}`);
    }
    // The legal edges: an unknown rate (null pair, null provenance), a null
    // ceiling (no finite bound, no block budget), and a terminal row with its stamp.
    await expect(
      insertJob({
        input_price_snapshot: null,
        output_price_snapshot: null,
        price_source: null,
        price_version_id: null,
        reserved_ceiling_micros: null,
      }),
    ).resolves.toBeDefined();
    await expect(
      insertJob({
        status: 'failed',
        terminal_at: new Date(),
        error_kind: 'submit_lost',
        completed_count: 0,
        failed_count: 0,
      }),
    ).resolves.toBeDefined();
  });

  it('carries no column that could hold a prompt, a response, or a client-authored id', async () => {
    const { rows } = await harness.pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name IN ('batch_job', 'request_log')`,
    );
    expect(rows.length).toBeGreaterThan(30);
    const suspicious = rows.filter((r) =>
      /body|prompt|response|content|text|payload|message(?!s?_)|custom_id|input_file|output_file/i.test(
        r.column_name,
      ),
    );
    // `request_log.error_message` is the sanitized provider-error text under its own
    // withheld-marker contract (add-request-error-detail) — not a body column.
    expect(suspicious.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      'request_log.error_message',
    ]);
    // Neither table stores a `custom_id` under any name.
    expect(rows.some((r) => /custom/i.test(r.column_name))).toBe(false);
  });

  it('request_log.batch_id is nullable, indexed, and has no foreign key; price_mode is sync|batch|null', async () => {
    const fk = await harness.pool.query(
      `SELECT 1 FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage k USING (constraint_name, table_schema)
        WHERE tc.table_name = 'request_log' AND tc.constraint_type = 'FOREIGN KEY'
          AND k.column_name = 'batch_id'`,
    );
    expect(fk.rowCount).toBe(0);
    const idx = await harness.pool.query(
      `SELECT 1 FROM pg_indexes WHERE tablename = 'request_log' AND indexname = 'request_log_batch_idx'`,
    );
    expect(idx.rowCount).toBe(1);

    const fresh = await harness.createTestPrincipal('log-batch-cols');
    // A batch item names a job that need not exist as a row (no FK: the item
    // outlives its job) and records the batch pricing rule.
    const item = logRow({ batchId: `job-${crypto.randomUUID()}`, priceMode: 'batch' });
    await harness.port.requestLogs.insertMany(fresh.principal, [item]);
    const stored = await harness.port.requestLogs.findById(fresh.principal, item.id);
    expect(stored?.batchId).toBe(item.batchId);
    expect(stored?.priceMode).toBe('batch');
    // Legacy rows carry null (read as sync); a synchronous row may say so.
    await harness.port.requestLogs.insertMany(fresh.principal, [logRow({ priceMode: 'sync' })]);
    await harness.port.requestLogs.insertMany(fresh.principal, [logRow()]);
    // The vocabulary is closed, and a batch-priced row must name its job.
    await violates(
      harness.port.requestLogs.insertMany(fresh.principal, [logRow({ priceMode: 'async' })]),
      'request_log_price_mode_valid',
    );
    await violates(
      harness.port.requestLogs.insertMany(fresh.principal, [
        logRow({ priceMode: 'batch', batchId: null }),
      ]),
      'request_log_batch_price_mode_compat',
    );
  });
});

describe('batch job accessor semantics (add-batch-inference, task 2.3)', () => {
  const values = (over: Partial<BatchJobInsertInput> = {}): BatchJobInsertInput => ({
    id: `job-${crypto.randomUUID()}`,
    agentId: 'agent-1',
    providerId: 'prov-1',
    modelId: 'model-1',
    tierAssigned: null,
    endpoint: '/v1/chat/completions',
    protocol: 'openai_compatible',
    providerKind: 'api_key',
    itemCount: 4,
    estimatedInputTokens: 400,
    priceMode: 'batch',
    inputPriceSnapshot: 1.25,
    outputPriceSnapshot: 5,
    cacheReadPriceSnapshot: null,
    cacheWritePriceSnapshot: null,
    priceVersionId: 'v1',
    priceSource: 'bundled',
    reservedCeilingMicros: 25_000,
    completionWindowMs: 86_400_000,
    ...over,
  });

  it('insert forces the D6 starting state; settle is accepted only from finalizing/cancelling and exactly once', async () => {
    const fresh = await harness.createTestPrincipal('batch-accessor');
    const jobs = harness.port.batchJobs;
    const row = await jobs.insert(fresh.principal, values());
    expect(row).toMatchObject({
      status: 'submitting',
      upstreamBatchId: null,
      completedCount: 0,
      failedCount: 0,
      cancelRequested: false,
      settledCostMicros: null,
      terminalAt: null,
      errorKind: null,
      reservedCeilingMicros: 25_000,
    });
    // A patch cannot reach a fixed-at-submission column, even through a cast.
    const smuggled = await jobs.update(fresh.principal, row.id, {
      reservedCeilingMicros: 0,
      inputPriceSnapshot: 0,
      ownerUserId: 'someone-else',
      lastPolledAt: new Date(),
    } as unknown as Parameters<typeof jobs.update>[2]);
    expect(smuggled?.reservedCeilingMicros).toBe(25_000);
    expect(smuggled?.inputPriceSnapshot).toBe(1.25);
    expect(smuggled?.ownerUserId).toBe(fresh.userId);
    expect(smuggled?.lastPolledAt).not.toBeNull();

    const settlement = {
      status: 'completed' as const,
      completedCount: 3,
      failedCount: 1,
      settledCostMicros: 12_345,
      terminalAt: new Date(),
    };
    // Not from `submitting`/`in_progress`…
    expect(await jobs.settle(fresh.principal, row.id, settlement)).toBeNull();
    await jobs.update(fresh.principal, row.id, { status: 'in_progress', upstreamBatchId: 'up' });
    expect(await jobs.settle(fresh.principal, row.id, settlement)).toBeNull();
    // …only from `finalizing` (or `cancelling`), and then never again.
    await jobs.update(fresh.principal, row.id, { status: 'finalizing' });
    const settled = await jobs.settle(fresh.principal, row.id, settlement);
    expect(settled).toMatchObject({
      status: 'completed',
      completedCount: 3,
      failedCount: 1,
      settledCostMicros: 12_345,
    });
    expect(settled?.terminalAt).not.toBeNull();
    expect(await jobs.settle(fresh.principal, row.id, settlement)).toBeNull();
    expect((await jobs.listActive(fresh.principal)).map((j) => j.id)).not.toContain(row.id);
  });

  it('lists active first, then terminal newest-first, and the keyset cursor walks every job exactly once', async () => {
    const fresh = await harness.createTestPrincipal('batch-listing');
    const jobs = harness.port.batchJobs;
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const row = await jobs.insert(
        fresh.principal,
        values({ agentId: i % 2 === 0 ? 'even' : 'odd' }),
      );
      ids.push(row.id);
    }
    // Make jobs 1, 3, 5 terminal (the rest stay active).
    for (const i of [1, 3, 5]) {
      await jobs.update(fresh.principal, ids[i]!, { status: 'finalizing' });
      await jobs.settle(fresh.principal, ids[i]!, {
        status: 'completed',
        completedCount: 4,
        failedCount: 0,
        settledCostMicros: 1,
        terminalAt: new Date(),
      });
    }
    const walked: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await jobs.list(fresh.principal, {
        limit: 2,
        ...(cursor !== null ? { cursor: decodeCursor(cursor) } : {}),
      });
      walked.push(...page.rows.map((r) => r.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(4);
    expect(walked).toHaveLength(7);
    expect(new Set(walked).size).toBe(7);
    // Active (0,2,4,6) before terminal (1,3,5); newest-submitted first within each band.
    expect(walked.slice(0, 4)).toEqual([ids[6], ids[4], ids[2], ids[0]]);
    expect(walked.slice(4)).toEqual([ids[5], ids[3], ids[1]]);
    // The agent filter narrows both the listing and the live set.
    const odd = await jobs.list(fresh.principal, { limit: 50, agentId: 'odd' });
    expect(odd.rows.map((r) => r.id).sort()).toEqual([ids[1], ids[3], ids[5]].sort());
    expect(
      (await jobs.listActive(fresh.principal, { agentId: 'even' })).map((r) => r.id).sort(),
    ).toEqual([ids[0], ids[2], ids[4], ids[6]].sort());
  });

  it('the reconciler’s pending read sums only live ceilings in the period, per owner and agent', async () => {
    const fresh = await harness.createTestPrincipal('batch-pending');
    const other = await harness.createTestPrincipal('batch-pending-other');
    const jobs = harness.port.batchJobs;
    await jobs.insert(fresh.principal, values({ agentId: 'a', reservedCeilingMicros: 100 }));
    await jobs.insert(fresh.principal, values({ agentId: 'b', reservedCeilingMicros: 20 }));
    await jobs.insert(fresh.principal, values({ agentId: 'a', reservedCeilingMicros: null })); // unbounded: 0
    const done = await jobs.insert(
      fresh.principal,
      values({ agentId: 'a', reservedCeilingMicros: 1_000 }),
    );
    await jobs.update(fresh.principal, done.id, { status: 'finalizing' });
    await jobs.settle(fresh.principal, done.id, {
      status: 'completed',
      completedCount: 4,
      failedCount: 0,
      settledCostMicros: 5,
      terminalAt: new Date(),
    });
    await jobs.insert(other.principal, values({ agentId: 'a', reservedCeilingMicros: 7_777 }));
    const start = new Date(Date.now() - 60_000);
    const end = new Date(Date.now() + 60_000);
    const pending = harness.maintenance.reservations;
    expect(await pending.pendingMicrosFor(fresh.userId, null, start, end)).toBe(120);
    expect(await pending.pendingMicrosFor(fresh.userId, 'a', start, end)).toBe(100);
    expect(await pending.pendingMicrosFor(fresh.userId, 'b', start, end)).toBe(20);
    expect(
      await pending.pendingMicrosFor(fresh.userId, null, end, new Date(end.getTime() + 1)),
    ).toBe(0);
  });
});

describe('requestLogs.insertManyReturning (add-batch-inference D9)', () => {
  it('reports exactly the ids that landed — a conflict replay reports zero new rows', async () => {
    const fresh = await harness.createTestPrincipal('log-returning');
    const a = logRow({ batchId: 'job-x', priceMode: 'batch' });
    const b = logRow({ batchId: 'job-x', priceMode: 'batch' });
    const first = await harness.port.requestLogs.insertManyReturning(fresh.principal, [a, b]);
    expect(first.insertedIds.sort()).toEqual([a.id, b.id].sort());
    // A crashed-and-rerun settlement chunk: nothing new, nothing doubled.
    const replay = await harness.port.requestLogs.insertManyReturning(fresh.principal, [a, b]);
    expect(replay.insertedIds).toEqual([]);
    // A partial overlap lands only the new row.
    const c = logRow({ batchId: 'job-x', priceMode: 'batch' });
    const partial = await harness.port.requestLogs.insertManyReturning(fresh.principal, [b, c]);
    expect(partial.insertedIds).toEqual([c.id]);
    expect(await harness.port.requestLogs.list(fresh.principal)).toHaveLength(3);
  });
});

describe('routingEntries.replaceForTier (#9 atomic chain replace)', () => {
  it('replaces atomically at positions 0..N-1 and is idempotent', async () => {
    const tier = await harness.port.tiers.insert(owner.principal, {
      key: `rep-${Math.random().toString(36).slice(2, 8)}`,
    });
    const models = await makeModels(3);
    const ids = models.map((m) => m.id);
    const res = await harness.port.routingEntries.replaceForTier(owner.principal, tier.id, ids);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') throw new Error('unreachable');
    expect(res.entries.map((e) => e.position)).toEqual([0, 1, 2]);
    expect(res.entries.map((e) => e.modelId)).toEqual(ids);

    // Replacing with a reordered subset overwrites the whole chain.
    const res2 = await harness.port.routingEntries.replaceForTier(owner.principal, tier.id, [
      ids[1]!,
      ids[0]!,
    ]);
    if (res2.status !== 'ok') throw new Error('expected ok');
    expect(res2.entries.map((e) => e.modelId)).toEqual([ids[1], ids[0]]);
    const stored = await harness.port.routingEntries.listForTier(owner.principal, tier.id);
    expect(stored.length).toBe(2);
  });

  it('rejects an unowned/nonexistent model as a unit — no partial write', async () => {
    const tier = await harness.port.tiers.insert(owner.principal, {
      key: `unit-${Math.random().toString(36).slice(2, 8)}`,
    });
    const models = await makeModels(2);
    const ids = models.map((m) => m.id);
    await harness.port.routingEntries.replaceForTier(owner.principal, tier.id, ids);

    const bad = await harness.port.routingEntries.replaceForTier(owner.principal, tier.id, [
      ids[0]!,
      'no-such-model',
    ]);
    expect(bad.status).toBe('unknown_models');
    if (bad.status === 'unknown_models') expect(bad.modelIds).toEqual(['no-such-model']);
    // The prior chain is untouched.
    const stored = await harness.port.routingEntries.listForTier(owner.principal, tier.id);
    expect(stored.map((e) => e.modelId).sort()).toEqual([...ids].sort());
  });

  it('returns tier_not_found for another tenant’s tier', async () => {
    const other = await harness.createTestPrincipal('replace-other');
    const otherTier = await harness.port.tiers.insert(other.principal, { key: 'default' });
    const [mine] = await makeModels(1);
    const res = await harness.port.routingEntries.replaceForTier(owner.principal, otherTier.id, [
      mine!.id,
    ]);
    expect(res.status).toBe('tier_not_found');
  });

  it('serializes two concurrent replacements of the same tier (no position collision)', async () => {
    const tier = await harness.port.tiers.insert(owner.principal, {
      key: `conc-${Math.random().toString(36).slice(2, 8)}`,
    });
    const models = await makeModels(5);
    const ids = models.map((m) => m.id);
    const chainA = [ids[0]!, ids[1]!, ids[2]!];
    const chainB = [ids[3]!, ids[4]!];
    const [ra, rb] = await Promise.all([
      harness.port.routingEntries.replaceForTier(owner.principal, tier.id, chainA),
      harness.port.routingEntries.replaceForTier(owner.principal, tier.id, chainB),
    ]);
    // The FOR UPDATE tier lock serializes them: both succeed, neither hits the
    // non-deferrable UNIQUE(tier_id, position).
    expect(ra.status).toBe('ok');
    expect(rb.status).toBe('ok');
    const stored = await harness.port.routingEntries.listForTier(owner.principal, tier.id);
    const modelIds = stored.map((e) => e.modelId);
    // Exactly one chain won — a clean, contiguous result.
    expect([chainA.length, chainB.length]).toContain(modelIds.length);
    expect(stored.map((e) => e.position).sort()).toEqual(
      Array.from({ length: modelIds.length }, (_, i) => i),
    );
  });
});
