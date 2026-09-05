// add-batch-inference task 4.9: the dashboard's owner-scoped batch surface —
// `GET /api/batches`, `GET /api/batches/:id` and the cancel, as safe views that
// carry metadata only and are indistinguishable from missing across tenants.
import request from 'supertest';
import type { App } from 'supertest/types';
import { BatchPoller } from '../../src/batch/batch.poller';
import { completeStubBatch } from '../proxy/stub-upstream';
import {
  createBatchHarness,
  doc,
  item,
  seedTenant,
  type BatchHarness,
  type Tenant,
} from './harness';

describe('dashboard batch surface — Phase B §4 (add-batch-inference)', () => {
  let h: BatchHarness;
  let server: App;
  let poller: BatchPoller;
  const userIds: string[] = [];
  let owner: Tenant;
  let other: Tenant;

  const submit = (t: Tenant, items: unknown[]) =>
    request(server)
      .post('/v1/batches')
      .set('Authorization', `Bearer ${t.key}`)
      .set('Content-Type', 'application/json')
      .send(doc('gpt-4o', items));
  const asOwner = (t: Tenant, path: string) =>
    request(server).get(path).set('x-test-user', t.userId);

  beforeAll(async () => {
    h = await createBatchHarness({ withPoller: true });
    server = h.app.getHttpServer();
    poller = h.poller!;
    owner = await seedTenant(h.port, h.pool, 'dash-owner', h.stub.url, null);
    other = await seedTenant(h.port, h.pool, 'dash-other', h.stub.url, null);
    userIds.push(owner.userId, other.userId);
  }, 90_000);

  afterAll(async () => {
    await h.close(userIds);
  });

  it('lists the owner’s jobs as safe views: labels with an id fallback, counts, and no body-shaped field', async () => {
    const live = (await submit(owner, [item('d1'), item('d2')])).body.id as string;
    const done = (await submit(owner, [item('d3')])).body.id as string;
    const upstream = h.stub.batches.get(
      (await h.port.batchJobs.findById(owner.principal, done))!.upstreamBatchId!,
    )!;
    completeStubBatch(upstream);
    await poller.sweep();

    const res = await asOwner(owner, '/api/batches?limit=50');
    expect(res.status).toBe(200);
    const rows = res.body.rows as Record<string, unknown>[];
    const byId = new Map(rows.map((r) => [r['id'] as string, r]));
    expect(byId.has(live)).toBe(true);
    expect(byId.has(done)).toBe(true);
    // Active first, then terminal — the order the band and the page both read.
    expect(rows.findIndex((r) => r['id'] === live)).toBeLessThan(
      rows.findIndex((r) => r['id'] === done),
    );

    const liveRow = byId.get(live)!;
    expect(liveRow).toMatchObject({
      terminal: false,
      endpoint: '/v1/chat/completions',
      modelLabel: 'gpt-4o',
      counts: { total: 2, completed: 0, failed: 0 },
      settledCostMicros: null, // a reservation is never rendered as spend (D13)
    });
    expect(liveRow['providerLabel']).toMatch(/^openrouter-/);
    expect(typeof liveRow['reservedCeilingMicros']).not.toBe('undefined');
    const doneRow = byId.get(done)!;
    expect(doneRow).toMatchObject({ terminal: true, status: 'completed' });
    expect(doneRow['reservedCeilingMicros']).toBeNull();
    expect(doneRow['settledCostMicros']).not.toBeNull();
    // The upstream's retention deadline, nullable — never invented.
    expect(Object.prototype.hasOwnProperty.call(doneRow, 'resultsExpireAt')).toBe(true);
    // A safe view: no ownership columns, and no field that could hold content.
    for (const row of rows) {
      expect(row['ownerUserId']).toBeUndefined();
      expect(row['orgId']).toBeUndefined();
      expect(JSON.stringify(row)).not.toMatch(/custom_id|messages|content|prompt/i);
    }
  });

  it('projects only live jobs for the band, and pages the full listing by cursor', async () => {
    const active = await asOwner(owner, '/api/batches?active=1');
    expect(active.status).toBe(200);
    expect((active.body.rows as { terminal: boolean }[]).every((r) => !r.terminal)).toBe(true);
    expect(active.body.nextCursor).toBeNull();

    const first = await asOwner(owner, '/api/batches?limit=1');
    expect((first.body.rows as unknown[]).length).toBe(1);
    expect(first.body.nextCursor).not.toBeNull();
    const next = await asOwner(
      owner,
      `/api/batches?limit=1&cursor=${encodeURIComponent(first.body.nextCursor as string)}`,
    );
    expect(next.status).toBe(200);
    expect((next.body.rows as { id: string }[])[0]!.id).not.toBe(
      (first.body.rows as { id: string }[])[0]!.id,
    );
    const bad = await asOwner(owner, '/api/batches?cursor=not-a-cursor');
    expect(bad.status).toBe(422);
  });

  it('reads and cancels one job, and another tenant’s id is a 404 on every surface', async () => {
    const id = (await submit(owner, [item('c1')])).body.id as string;
    const mine = await asOwner(owner, `/api/batches/${id}`);
    expect(mine.status).toBe(200);
    expect(mine.body.id).toBe(id);

    expect((await asOwner(other, `/api/batches/${id}`)).status).toBe(404);
    expect((await asOwner(owner, '/api/batches/nope')).status).toBe(404);
    const foreignCancel = await request(server)
      .post(`/api/batches/${id}/cancel`)
      .set('x-test-user', other.userId);
    expect(foreignCancel.status).toBe(404);
    // The victim's job is untouched.
    expect((await h.port.batchJobs.findById(owner.principal, id))!.status).toBe('validating');

    const cancel = await request(server)
      .post(`/api/batches/${id}/cancel`)
      .set('x-test-user', owner.userId);
    expect(cancel.status).toBe(201);
    expect(cancel.body.status).toBe('cancelling');
    expect((await h.port.batchJobs.findById(owner.principal, id))!.cancelRequested).toBe(true);
  });

  it('requires a session on the /api plane while leaving /v1 to the agent key', async () => {
    expect((await request(server).get('/api/batches')).status).toBe(401);
    expect(
      (await request(server).get('/v1/batches').set('Authorization', `Bearer ${owner.key}`)).status,
    ).toBe(200);
  });
});
