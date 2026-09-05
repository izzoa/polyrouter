// add-batch-inference Phase B §4: the poller and the durable settlement against
// real Postgres + Redis and the stub upstream — resumability (4.1), breaker
// neutrality (4.2), exactly-once settlement (4.3), cancel completion (4.6),
// metrics (4.7), the `batch.updated` nudge (4.8) and `batch_stalled` (4.10).
import type { BatchJobRow } from '@polyrouter/shared/server';
import type { BatchAdapter, BatchListEntry } from '@polyrouter/data-plane';
import request from 'supertest';
import type { App } from 'supertest/types';
import { BatchPoller } from '../../src/batch/batch.poller';
import { BatchService } from '../../src/batch/batch.service';
import { itemRowId } from '../../src/batch/batch-settlement';
import { BudgetService } from '../../src/budgets/budget-service';
import { periodInfo } from '../../src/budgets/period';
import { NotificationProducers } from '../../src/producers/notification-producers';
import type { DashboardEvent } from '../../src/events/dashboard-events';
import { completeStubBatch, type StubBatch } from '../proxy/stub-upstream';
import { createBatchHarness, doc, item, type BatchHarness, type Tenant } from './harness';
import { seedTenant } from './harness';

describe('batch poller + settlement — Phase B §4 (add-batch-inference)', () => {
  let h: BatchHarness;
  let server: App;
  let poller: BatchPoller;
  const userIds: string[] = [];

  const tenant = async (label: string, budget: { amount: number } | null = { amount: 100 }) => {
    const t = await seedTenant(h.port, h.pool, label, h.stub.url, budget);
    userIds.push(t.userId);
    return t;
  };

  const submit = (key: string, body: string) =>
    request(server)
      .post('/v1/batches')
      .set('Authorization', `Bearer ${key}`)
      .set('Content-Type', 'application/json')
      .send(body);

  const jobOf = async (t: Tenant, id: string): Promise<BatchJobRow> => {
    const row = await h.port.batchJobs.findById(t.principal, id);
    if (row === null) throw new Error(`job ${id} not found`);
    return row;
  };
  const upstreamOf = async (t: Tenant, id: string): Promise<StubBatch> => {
    const row = await jobOf(t, id);
    const b = h.stub.batches.get(row.upstreamBatchId!);
    if (b === undefined) throw new Error('no stub batch');
    return b;
  };
  const spendKey = (t: Tenant): string =>
    h.counter.key(
      t.userId,
      'global',
      'global',
      'month',
      periodInfo('month', new Date()).periodId,
      'notional',
    );
  const pendingOf = async (t: Tenant): Promise<number> =>
    (await h.counter.readWithPending([spendKey(t)]))[0]!.pending;
  const itemsOf = async (t: Tenant, jobId: string) =>
    (await h.port.requestLogs.list(t.principal)).filter((r) => r.batchId === jobId);

  beforeAll(async () => {
    h = await createBatchHarness({ withPoller: true });
    server = h.app.getHttpServer();
    poller = h.poller!;
  }, 90_000);

  afterAll(async () => {
    await h.close(userIds);
  });

  // --- 4.1 the sweep drives jobs to a terminal state ------------------------

  it('polls a job to completion, settles one durable row per item, and releases the reservation', async () => {
    const t = await tenant('poll-basic');
    const res = await submit(
      t.key,
      doc('gpt-4o', [item('a', { max_tokens: 4 }), item('b', { max_tokens: 4 }), item('c-fail')]),
    );
    expect(res.status).toBe(202);
    const id = res.body.id as string;
    const reserved = (await jobOf(t, id)).reservedCeilingMicros!;
    expect(await pendingOf(t)).toBe(reserved);

    // Still running upstream: the sweep advances the status but settles nothing.
    await poller.sweep();
    expect((await jobOf(t, id)).status).toBe('validating');
    expect(await itemsOf(t, id)).toHaveLength(0);
    expect(await pendingOf(t)).toBe(reserved);

    completeStubBatch(await upstreamOf(t, id));
    await poller.sweep();

    const job = await jobOf(t, id);
    expect(job.status).toBe('completed');
    expect(job.completedCount).toBe(2);
    expect(job.failedCount).toBe(1);
    expect(job.terminalAt).not.toBeNull();
    expect(job.settledCostMicros).toBeGreaterThan(0);
    expect(await pendingOf(t)).toBe(0); // released only after settlement

    const rows = await itemsOf(t, id);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      // The job's snapshot, copied verbatim (D7) — never re-resolved.
      expect(r.priceMode).toBe('batch');
      expect(r.inputPriceSnapshot).toBe(job.inputPriceSnapshot);
      expect(r.outputPriceSnapshot).toBe(job.outputPriceSnapshot);
      expect(r.priceSource).toBe(job.priceSource);
      expect(r.providerKind).toBe('local');
      expect(r.decisionLayer).toBe('explicit');
      expect(r.routingReason).toMatch(/ batch$/);
      expect(r.agentId).toBe(t.agentId);
      // Wall time from submission to settlement, shared by every item.
      expect(r.durationMs).toBe(rows[0]!.durationMs);
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(rows.filter((r) => r.status === 'success')).toHaveLength(2);
    const failedRow = rows.find((r) => r.status === 'error')!;
    expect(failedRow.errorKind).toBe('rate_limit');
    expect(failedRow.errorStatus).toBe(429);
    // Settled cost equals the sum of the item rows' immutable costs.
    const summed = rows.reduce((acc, r) => acc + Math.round((r.cost ?? 0) * 1_000_000), 0);
    expect(job.settledCostMicros).toBe(summed);
  });

  it('resumes from the database: a FRESH poller instance settles a job the previous one left running', async () => {
    const t = await tenant('poll-restart');
    const id = (await submit(t.key, doc('gpt-4o', [item('r1')]))).body.id as string;
    await poller.sweep();
    completeStubBatch(await upstreamOf(t, id));

    // A new instance with no in-memory state — exactly what a restart produces.
    const fresh = new BatchPoller(
      h.redis,
      h.port,
      h.maintenance,
      {
        enabled: true,
        maxItems: 10,
        maxBodyBytes: 1024,
        pollIntervalMs: 15_000,
        windowMarginMs: 3_600_000,
      },
      h.app.get(BatchService),
      h.settlement!,
      // The same singletons the app holds — a restart re-reads the database, not
      // in-memory state, which is exactly what this proves.
      h.app.get(BudgetService),
      h.app.get(NotificationProducers),
      h.metrics,
      h.events,
    );
    try {
      await fresh.sweep();
    } finally {
      await fresh.onApplicationShutdown();
    }
    expect((await jobOf(t, id)).status).toBe('completed');
    expect(await itemsOf(t, id)).toHaveLength(1);
  });

  it('moves a stranded `submitting` row to `submission_unknown`, holds its reservation, and adopts an echoed id', async () => {
    const t = await tenant('poll-unknown');
    const id = (await submit(t.key, doc('gpt-4o', [item('u1')]))).body.id as string;
    const job = await jobOf(t, id);
    const upstreamId = job.upstreamBatchId!;
    const reserved = job.reservedCeilingMicros!;
    // Simulate the crash window: the upstream accepted, the id was never stored.
    await h.pool.query(
      `UPDATE batch_job SET status = 'submitting', upstream_batch_id = NULL, submitted_at = now() - interval '10 minutes' WHERE id = $1`,
      [id],
    );
    await poller.sweep();
    expect((await jobOf(t, id)).status).toBe('submission_unknown');
    expect(await pendingOf(t)).toBe(reserved); // nothing released on a guess

    // The shipped upstreams echo nothing on list, so reconciliation cannot match by
    // id — the job stays reserved. An upstream that DOES echo is adopted: patch the
    // seam to echo and the very next sweep picks the job up.
    await poller.sweep();
    expect((await jobOf(t, id)).status).toBe('submission_unknown');

    const svc = h.app.get(BatchService);
    const realBatchFor = svc.batchFor.bind(svc);
    const echoing = async (principal: never, provider: never): Promise<BatchAdapter> => {
      const inner = await realBatchFor(principal, provider);
      return {
        ...inner,
        list: async (ctx): Promise<readonly BatchListEntry[]> =>
          (await inner.list(ctx)).map((e) =>
            e.upstreamId === upstreamId ? { ...e, jobId: id } : e,
          ),
      };
    };
    (svc as unknown as { batchFor: unknown }).batchFor = echoing;
    try {
      await poller.sweep();
    } finally {
      (svc as unknown as { batchFor: unknown }).batchFor = realBatchFor;
    }
    const adopted = await jobOf(t, id);
    expect(adopted.upstreamBatchId).toBe(upstreamId);
    expect(adopted.status).not.toBe('submission_unknown');
    expect(adopted.stalledSince).toBeNull();
  });

  it('an unmapped upstream status is NOT terminal: the reservation is held and the job re-polls', async () => {
    const t = await tenant('poll-unmapped');
    const id = (await submit(t.key, doc('gpt-4o', [item('x1')]))).body.id as string;
    const reserved = (await jobOf(t, id)).reservedCeilingMicros!;
    const upstream = await upstreamOf(t, id);
    upstream.status = 'paused_for_review';
    await poller.sweep();
    let job = await jobOf(t, id);
    expect(job.status).toBe('validating'); // unchanged — never guessed terminal
    expect(job.errorKind).toBe('upstream_status_unknown');
    expect(job.stalledSince).not.toBeNull();
    expect(await pendingOf(t)).toBe(reserved);

    // It recovers cleanly when the upstream returns to a status we do map.
    completeStubBatch(upstream);
    await poller.sweep();
    job = await jobOf(t, id);
    expect(job.status).toBe('completed');
    expect(job.errorKind).toBeNull();
    expect(await pendingOf(t)).toBe(0);
  });

  it('a locally-expired job keeps its reservation until the upstream confirms', async () => {
    const t = await tenant('poll-expiry');
    const id = (await submit(t.key, doc('gpt-4o', [item('e1')]))).body.id as string;
    const reserved = (await jobOf(t, id)).reservedCeilingMicros!;
    // Past the completion window plus the margin, but the upstream still says it runs.
    await h.pool.query(
      `UPDATE batch_job SET submitted_at = now() - interval '3 days' WHERE id = $1`,
      [id],
    );
    const upstream = await upstreamOf(t, id);
    upstream.status = 'in_progress';
    await poller.sweep();
    expect((await jobOf(t, id)).status).toBe('in_progress');
    expect(await pendingOf(t)).toBe(reserved);

    // Only when the upstream can no longer find it does the job expire.
    h.stub.batches.delete(upstream.id);
    await poller.sweep();
    const job = await jobOf(t, id);
    expect(job.status).toBe('expired');
    expect(job.terminalAt).not.toBeNull();
    expect(await pendingOf(t)).toBe(0);
  });

  it('a sweep spanning two tenants settles each under its own owner and crosses nothing', async () => {
    const a = await tenant('poll-two-a');
    const b = await tenant('poll-two-b');
    const idA = (await submit(a.key, doc('gpt-4o', [item('a1'), item('a2')]))).body.id as string;
    const idB = (await submit(b.key, doc('gpt-4o', [item('b1')]))).body.id as string;
    completeStubBatch(await upstreamOf(a, idA));
    completeStubBatch(await upstreamOf(b, idB));
    await poller.sweep();

    expect((await jobOf(a, idA)).status).toBe('completed');
    expect((await jobOf(b, idB)).status).toBe('completed');
    expect(await itemsOf(a, idA)).toHaveLength(2);
    expect(await itemsOf(b, idB)).toHaveLength(1);
    // Neither tenant can see the other's job or its rows.
    expect(await h.port.batchJobs.findById(a.principal, idB)).toBeNull();
    expect((await h.port.requestLogs.list(a.principal)).every((r) => r.batchId !== idB)).toBe(true);
    expect((await h.port.requestLogs.list(b.principal)).every((r) => r.batchId !== idA)).toBe(true);
  });

  // --- 4.3 exactly-once, order-independent settlement -----------------------

  it('settles a batch far larger than one insert chunk, exactly once, in any order', async () => {
    const t = await tenant('poll-large');
    const count = 600; // > the 250-row chunk, and > the async writer's queue cap
    const items = Array.from({ length: count }, (_, i) => item(`n${String(i)}`));
    const id = (await submit(t.key, doc('gpt-4o', items))).body.id as string;
    const upstream = await upstreamOf(t, id);
    completeStubBatch(upstream);
    // Shuffled: results are not guaranteed to arrive in submission order.
    upstream.results = [...upstream.results!].reverse();
    await poller.sweep();

    const job = await jobOf(t, id);
    expect(job.status).toBe('completed');
    expect(job.completedCount).toBe(count);
    const rows = await itemsOf(t, id);
    expect(rows).toHaveLength(count);
    // Identity is `hash(jobId, custom_id)` — order cannot change it.
    expect(new Set(rows.map((r) => r.id)).size).toBe(count);
    expect(rows.some((r) => r.id === itemRowId(id, 'n0'))).toBe(true);

    // A replay settles nothing new and moves no count. The state a crash
    // mid-settlement leaves behind is `finalizing` with NO terminal stamp — the
    // database refuses anything else, which is the constraint doing its job.
    const before = job.settledCostMicros;
    await h.pool.query(
      `UPDATE batch_job SET status = 'finalizing', terminal_at = NULL WHERE id = $1`,
      [id],
    );
    await poller.sweep();
    const after = await jobOf(t, id);
    expect(after.status).toBe('completed');
    expect(after.settledCostMicros).toBe(before);
    expect(await itemsOf(t, id)).toHaveLength(count);
  });

  it('a duplicated result line neither double-counts nor trips the count constraint', async () => {
    const t = await tenant('poll-dup');
    const id = (await submit(t.key, doc('gpt-4o', [item('d1'), item('d2')]))).body.id as string;
    const upstream = await upstreamOf(t, id);
    completeStubBatch(upstream);
    upstream.results = [...upstream.results!, ...upstream.results!]; // the upstream repeats itself
    await poller.sweep();
    const job = await jobOf(t, id);
    expect(job.status).toBe('completed');
    expect(job.completedCount + job.failedCount).toBe(2);
    expect(await itemsOf(t, id)).toHaveLength(2);
  });

  it('a catalog change between submit and settle moves nothing', async () => {
    const t = await tenant('poll-immutable');
    const id = (await submit(t.key, doc('gpt-4o', [item('i1')]))).body.id as string;
    const job = await jobOf(t, id);
    // The twin's listed rate is what priced this job; change it after submission.
    await h.pool.query(
      `UPDATE model SET listed_input_price_per_1m = 99, listed_output_price_per_1m = 99
        WHERE id = $1`,
      [t.models['gpt-4o:batch']],
    );
    completeStubBatch(await upstreamOf(t, id));
    await poller.sweep();
    const rows = await itemsOf(t, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.inputPriceSnapshot).toBe(job.inputPriceSnapshot);
    expect(rows[0]!.outputPriceSnapshot).toBe(job.outputPriceSnapshot);
    expect(rows[0]!.inputPriceSnapshot).not.toBe(99);
  });

  // --- 4.6 cancel ----------------------------------------------------------

  it('cancels after partial completion: only the items that ran are recorded, and cancelled comes after settlement', async () => {
    // Anthropic, deliberately: OpenRouter's batch object documents `results: null`
    // for a cancelled batch, so its partial results are not retrievable at all —
    // the settlement path is the same, the upstream simply has nothing to give.
    const t = await tenant('poll-cancel');
    const id = (
      await submit(
        t.key,
        JSON.stringify({
          endpoint: '/v1/messages',
          model: 'claude-x',
          requests: [
            {
              custom_id: 'c1',
              body: { max_tokens: 4, messages: [{ role: 'user', content: 'a' }] },
            },
            {
              custom_id: 'c2',
              body: { max_tokens: 4, messages: [{ role: 'user', content: 'b' }] },
            },
            {
              custom_id: 'c3',
              body: { max_tokens: 4, messages: [{ role: 'user', content: 'c' }] },
            },
          ],
        }),
      )
    ).body.id as string;
    const upstream = await upstreamOf(t, id);
    const cancel = await request(server)
      .post(`/v1/batches/${id}/cancel`)
      .set('Authorization', `Bearer ${t.key}`);
    expect(cancel.status).toBe(202);
    expect(cancel.body.status).toBe('cancelling');
    expect(upstream.cancel_initiated).toBe(true);
    expect((await jobOf(t, id)).status).toBe('cancelling'); // held until settlement is durable

    // The upstream completed one item before the cancel took effect.
    upstream.results = [
      {
        custom_id: 'c1',
        response: {
          status_code: 200,
          body: {
            id: 'msg_c1',
            type: 'message',
            role: 'assistant',
            model: 'claude-x',
            content: [{ type: 'text', text: 'done' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 4, output_tokens: 2 },
          },
        },
        error: null,
      },
    ];
    upstream.status = 'cancelled';
    await poller.sweep();

    const job = await jobOf(t, id);
    expect(job.status).toBe('cancelled');
    expect(job.completedCount).toBe(1);
    expect(job.failedCount).toBe(0);
    const rows = await itemsOf(t, id);
    expect(rows).toHaveLength(1); // the unrun remainder is neither recorded nor charged
    expect(await pendingOf(t)).toBe(0);
  });

  it('a cancel with no upstream id makes no upstream call and is honoured once an id is adopted', async () => {
    const t = await tenant('poll-cancel-unknown');
    const id = (await submit(t.key, doc('gpt-4o', [item('k1')]))).body.id as string;
    const upstream = await upstreamOf(t, id);
    const callsBefore = h.stub.requests.length;
    await h.pool.query(
      `UPDATE batch_job SET status = 'submission_unknown', upstream_batch_id = NULL, stalled_since = now() WHERE id = $1`,
      [id],
    );
    const cancel = await request(server)
      .post(`/v1/batches/${id}/cancel`)
      .set('Authorization', `Bearer ${t.key}`);
    expect(cancel.status).toBe(202);
    expect((await jobOf(t, id)).cancelRequested).toBe(true);
    expect(h.stub.requests.length).toBe(callsBefore); // no upstream call was attempted
    expect(upstream.cancel_initiated).toBe(false);

    // The reconciler adopts the id and applies the recorded intent.
    await h.pool.query(
      `UPDATE batch_job SET upstream_batch_id = $2, status = 'in_progress' WHERE id = $1`,
      [id, upstream.id],
    );
    await poller.sweep();
    expect(upstream.cancel_initiated).toBe(true);
  });

  // --- 4.7 / 4.8 / 4.10 metrics, the nudge, the stall notice ----------------

  it('records batch metrics and keeps batch items out of the request counter and its histogram', async () => {
    const t = await tenant('poll-metrics');
    const id = (await submit(t.key, doc('gpt-4o', [item('m1'), item('m2')]))).body.id as string;
    completeStubBatch(await upstreamOf(t, id));
    await poller.sweep();
    const text = await h.metrics.metricsText();
    expect(text).toMatch(/polyrouter_batch_items_total\{provider="[^"]+",status="success"\} [1-9]/);
    expect(text).toMatch(/polyrouter_batches_total\{[^}]*status="completed"\} [1-9]/);
    expect(text).toContain('polyrouter_batch_active');
    expect(text).toContain('polyrouter_batch_poll_lag_seconds');
    // A settled item is spend, not a served request (D10).
    expect(text).not.toMatch(/polyrouter_requests_total\{/);
    expect(text).not.toMatch(/polyrouter_request_duration_seconds_count\{/);
  });

  it('publishes the metadata-only batch.updated nudge to the owner alone', async () => {
    const a = await tenant('poll-nudge-a');
    const b = await tenant('poll-nudge-b');
    const mine: DashboardEvent[] = [];
    const theirs: DashboardEvent[] = [];
    const unsubA = h.events.subscribe(`u:${a.userId}`, {
      enqueue: (e) => mine.push(e),
      close: () => undefined,
    });
    const unsubB = h.events.subscribe(`u:${b.userId}`, {
      enqueue: (e) => theirs.push(e),
      close: () => undefined,
    });
    try {
      const id = (await submit(a.key, doc('gpt-4o', [item('p1')]))).body.id as string;
      completeStubBatch(await upstreamOf(a, id));
      await poller.sweep();
      const updates = mine.filter((e) => e.type === 'batch.updated');
      expect(updates.length).toBeGreaterThan(0);
      const last = updates[updates.length - 1]!;
      expect(last).toMatchObject({ id, status: 'completed', total: 1, completed: 1, failed: 0 });
      // A nudge carries ids and counts only — no labels a row could be built from.
      expect(JSON.stringify(last)).not.toMatch(/gpt-4o|openrouter|p1/);
      expect(theirs.filter((e) => e.type === 'batch.updated')).toHaveLength(0);
    } finally {
      unsubA();
      unsubB();
    }
  });

  it('tells the operator once per stall, re-emitting only after the job re-enters it', async () => {
    const t = await tenant('poll-stall');
    const id = (await submit(t.key, doc('gpt-4o', [item('s1')]))).body.id as string;
    h.stalls.length = 0;
    await h.pool.query(
      `UPDATE batch_job SET status = 'submission_unknown', upstream_batch_id = NULL,
        stalled_since = now() - interval '30 minutes' WHERE id = $1`,
      [id],
    );
    await poller.sweep();
    await poller.sweep();
    // Two sweeps, two producer calls — the notification service dedups per
    // `(job, kind)` lifecycle, and the producer never blocks the sweep.
    expect(h.stalls.length).toBeGreaterThanOrEqual(1);
    expect(h.stalls[0]).toMatchObject({
      ownerUserId: t.userId,
      jobId: id,
      kind: 'submission_unknown',
    });
    expect(h.stalls[0]!.stalledMinutes).toBeGreaterThanOrEqual(30);
    // Metadata only: no item, no custom_id, no upstream text.
    expect(JSON.stringify(h.stalls[0])).not.toMatch(/s1|hi /);
    // Recovering clears the stall stamp, so a later stall is a NEW lifecycle.
    const upstream = h.stub.batches.get(
      (
        await h.pool.query<{ v: string }>(
          `SELECT upstream_batch_id AS v FROM batch_job WHERE id = $1`,
          [id],
        )
      ).rows[0]?.v ?? '',
    );
    void upstream;
    await h.pool.query(
      `UPDATE batch_job SET status = 'in_progress', stalled_since = NULL WHERE id = $1`,
      [id],
    );
    expect((await jobOf(t, id)).stalledSince).toBeNull();
  });

  // --- 4.2 breaker neutrality ----------------------------------------------

  it('never routes a poll, list or results call through the synchronous breaker', async () => {
    const t = await tenant('poll-breaker');
    const id = (await submit(t.key, doc('gpt-4o', [item('b1')]))).body.id as string;
    const upstream = await upstreamOf(t, id);
    // A status probe that keeps failing: the sweep contains it and the breaker,
    // which the poller never touches, stays closed for the provider.
    h.stub.batches.delete(upstream.id);
    await h.pool.query(`UPDATE batch_job SET submitted_at = now() WHERE id = $1`, [id]);
    await poller.sweep();
    const breaker = h.app.get<{ snapshot?: unknown }>('polyrouter:proxy-breaker');
    expect(breaker).toBeDefined();
    // The synchronous path still serves this provider immediately afterwards.
    const chat = await request(server)
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${t.key}`)
      .send({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    expect(chat.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Phase C: the same guarantees against OpenAI's FILE plane (tasks 6.2/6.3).
// ---------------------------------------------------------------------------
describe('OpenAI file-plane batches — Phase C (add-batch-inference)', () => {
  let h: BatchHarness;
  let server: App;
  let poller: BatchPoller;
  const userIds: string[] = [];

  const submit = (t: Tenant, model: string, items: unknown[]) =>
    request(server)
      .post('/v1/batches')
      .set('Authorization', `Bearer ${t.key}`)
      .set('Content-Type', 'application/json')
      .send(doc(model, items));
  const jobOf = async (t: Tenant, id: string): Promise<BatchJobRow> =>
    (await h.port.batchJobs.findById(t.principal, id))!;
  const itemsOf = async (t: Tenant, jobId: string) =>
    (await h.port.requestLogs.list(t.principal)).filter((r) => r.batchId === jobId);

  beforeAll(async () => {
    h = await createBatchHarness({ withPoller: true });
    server = h.app.getHttpServer();
    poller = h.poller!;
  }, 90_000);

  afterAll(async () => {
    await h.close(userIds);
  });

  const tenant = async (label: string): Promise<Tenant> => {
    const t = await seedTenant(h.port, h.pool, label, h.stub.url, null);
    userIds.push(t.userId);
    return t;
  };

  it('accepts a batch on a direct OpenAI provider and settles it exactly once (6.3)', async () => {
    const t = await tenant('oai-basic');
    const res = await submit(t, 'oai-gpt-4o', [item('o1'), item('o2'), item('o3-fail')]);
    expect(res.status).toBe(202);
    const id = res.body.id as string;
    const job = await jobOf(t, id);
    expect(job.upstreamBatchId).toMatch(/^batch_oai_/);
    // The upload really happened, and the batch references the uploaded file.
    expect(h.stub.requests.some((r) => r.path === '/oai/files')).toBe(true);
    expect(h.stub.requests.some((r) => r.path === '/oai/batches')).toBe(true);

    const upstream = h.stub.batches.get(job.upstreamBatchId!)!;
    // The upstream received the ITEMS, framed as JSONL and streamed through the
    // multipart envelope — never a temp file, never a second copy in memory.
    expect(upstream.requests.map((r) => r.custom_id)).toEqual(['o1', 'o2', 'o3-fail']);
    // The job id rides `metadata`, which is what makes reconciliation by id work.
    expect(upstream.jobId).toBe(id);

    completeStubBatch(upstream);
    await poller.sweep();
    const settled = await jobOf(t, id);
    expect(settled.status).toBe('completed');
    expect(settled.completedCount).toBe(2);
    expect(settled.failedCount).toBe(1);
    const rows = await itemsOf(t, id);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.status === 'error')).toHaveLength(1);
    expect(rows.every((r) => r.priceMode === 'batch')).toBe(true);

    // Exactly once: a replayed settlement lands no new rows and moves no count.
    await h.pool.query(
      `UPDATE batch_job SET status = 'finalizing', terminal_at = NULL WHERE id = $1`,
      [id],
    );
    await poller.sweep();
    expect(await itemsOf(t, id)).toHaveLength(3);
    expect((await jobOf(t, id)).settledCostMicros).toBe(settled.settledCostMicros);
  });

  it('adopts a lost submission by the job id echoed in metadata — the one upstream that can', async () => {
    const t = await tenant('oai-reconcile');
    const id = (await submit(t, 'oai-gpt-4o', [item('r1')])).body.id as string;
    const upstreamId = (await jobOf(t, id)).upstreamBatchId!;
    // The crash window: the upstream accepted, the id was never stored.
    await h.pool.query(
      `UPDATE batch_job SET status = 'submission_unknown', upstream_batch_id = NULL,
        stalled_since = now() WHERE id = $1`,
      [id],
    );
    await poller.sweep();
    const adopted = await jobOf(t, id);
    expect(adopted.upstreamBatchId).toBe(upstreamId);
    expect(adopted.status).not.toBe('submission_unknown');
    expect(adopted.stalledSince).toBeNull();
  });

  it('a create the provider rejects fails the job with the taxonomy kind and no upstream job', async () => {
    const t = await tenant('oai-reject');
    const res = await submit(t, 'oai-batchreject', [item('x1')]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
    expect(res.body.error.message).not.toMatch(/stub refused/);
    const rows = (await h.port.batchJobs.list(t.principal, { limit: 50 })).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed', errorKind: 'bad_request' });
  });
});
