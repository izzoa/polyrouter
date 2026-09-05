// add-batch-inference task 4.5 (the results pass-through) and 4.4 (the
// invariant-8 sentinel sweep). polyrouter is a broker: results are streamed from
// the upstream, translated into the caller's protocol, and stored nowhere.
import { Logger } from '@nestjs/common';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import type { App } from 'supertest/types';
import { BatchPoller } from '../../src/batch/batch.poller';
import { completeStubBatch } from '../proxy/stub-upstream';
import { createBatchHarness, seedTenant, type BatchHarness, type Tenant } from './harness';

/** Sentinels that must never survive anywhere but the bytes handed to the caller. */
const BODY_SENTINEL = 'ZZQPROMPTSENTINELZZ';
const CUSTOM_ID_SENTINEL = 'ZZQCUSTOMIDSENTINELZZ';
const RESULT_SENTINEL = 'ZZQRESULTSENTINELZZ';

describe('batch results + the broker guarantee — Phase B §4 (add-batch-inference)', () => {
  let h: BatchHarness;
  let server: App;
  let poller: BatchPoller;
  let port: number;
  const userIds: string[] = [];
  const logLines: string[] = [];
  let logSpies: jest.SpyInstance[] = [];

  const tenant = async (label: string): Promise<Tenant> => {
    const t = await seedTenant(h.port, h.pool, label, h.stub.url, null);
    userIds.push(t.userId);
    return t;
  };
  const submitAnthropic = (key: string, model: string, items: unknown[]) =>
    request(server)
      .post('/v1/batches')
      .set('Authorization', `Bearer ${key}`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ endpoint: '/v1/messages', model, requests: items }));
  const antItem = (id: string, text: string) => ({
    custom_id: id,
    body: { max_tokens: 8, messages: [{ role: 'user', content: text }] },
  });
  const upstreamOf = async (t: Tenant, id: string) => {
    const row = await h.port.batchJobs.findById(t.principal, id);
    return h.stub.batches.get(row!.upstreamBatchId!)!;
  };
  /** Mark a job terminal WITHOUT settling it: these cases exercise the read path
   * alone, and settling a 13 MiB result set into the ledger would test the
   * poller (which the poller suite already does) rather than the stream. */
  const markCompleted = (id: string): Promise<unknown> =>
    h.pool.query(`UPDATE batch_job SET status = 'completed', terminal_at = now() WHERE id = $1`, [
      id,
    ]);

  beforeAll(async () => {
    h = await createBatchHarness({ withPoller: true });
    server = h.app.getHttpServer();
    poller = h.poller!;
    // A real listener, so a test can drive a raw socket (disconnect, slow reader).
    await new Promise<void>((resolve) =>
      (server as unknown as http.Server).listen(0, '127.0.0.1', resolve),
    );
    port = ((server as unknown as http.Server).address() as AddressInfo).port;
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      logSpies.push(
        jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
          logLines.push(args.map((a) => String(a)).join(' '));
        }),
      );
    }
  }, 90_000);

  afterAll(async () => {
    for (const s of logSpies) s.mockRestore();
    logSpies = [];
    await h.close(userIds);
  });

  // --- 4.5 the results sub-resource ----------------------------------------

  it('is 409 before completion, and the metadata read never carries results at any point', async () => {
    const t = await tenant('res-ready');
    const id = (await submitAnthropic(t.key, 'claude-x', [antItem('r1', 'hello')])).body
      .id as string;
    const early = await request(server)
      .get(`/v1/batches/${id}/results`)
      .set('Authorization', `Bearer ${t.key}`);
    expect(early.status).toBe(409);
    expect(early.body).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: expect.stringMatching(/not ready/) },
    });
    const during = await request(server)
      .get(`/v1/batches/${id}`)
      .set('Authorization', `Bearer ${t.key}`);
    expect(during.status).toBe(200);
    expect(during.body.results).toBeUndefined();
    expect(during.body.results_url).toBeNull();

    completeStubBatch(await upstreamOf(t, id));
    await poller.sweep();
    const after = await request(server)
      .get(`/v1/batches/${id}`)
      .set('Authorization', `Bearer ${t.key}`);
    expect(after.status).toBe(200);
    expect(after.body.status).toBe('completed');
    expect(after.body.results).toBeUndefined(); // metadata only, always (D25)
    expect(after.body.results_url).toBe(`/v1/batches/${id}/results`);
    expect(after.body.output_file_id).toBeNull();
  });

  it('streams JSONL in the caller’s protocol, is re-readable, and writes nothing between reads', async () => {
    const t = await tenant('res-read');
    const id = (
      await submitAnthropic(t.key, 'claude-x', [antItem('a', 'one'), antItem('b-fail', 'two')])
    ).body.id as string;
    completeStubBatch(await upstreamOf(t, id));
    await poller.sweep();

    const read = () =>
      request(server)
        .get(`/v1/batches/${id}/results`)
        .set('Authorization', `Bearer ${t.key}`)
        .buffer(true)
        .parse((res, cb) => {
          let text = '';
          res.on('data', (c: Buffer) => (text += c.toString('utf8')));
          res.on('end', () => cb(null, text));
        });

    const first = await read();
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toMatch(/ndjson/);
    const rowsBefore = (await h.port.requestLogs.list(t.principal)).length;
    const lines = (first.body as string)
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    const ok = lines.find((l) => l['custom_id'] === 'a')!;
    // Anthropic in, Anthropic out — translated by the same module the sync path uses.
    expect((ok['response'] as { status_code: number }).status_code).toBe(200);
    const body = (ok['response'] as { body: Record<string, unknown> }).body;
    expect(body['type']).toBe('message');
    expect(body['role']).toBe('assistant');
    expect(ok['error']).toBeNull();
    const failed = lines.find((l) => l['custom_id'] === 'b-fail')!;
    expect(failed['response']).toBeNull();
    expect((failed['error'] as { code: string }).code).toBe('rate_limit');
    // A fixed message per kind — never the upstream's own text.
    expect(JSON.stringify(failed)).not.toContain('stub rate limited');

    const second = await read();
    expect(second.body).toEqual(first.body); // identical, and nothing was stored
    expect((await h.port.requestLogs.list(t.principal)).length).toBe(rowsBefore);
  });

  it('streams a result set past the buffered-response cap without buffering it', async () => {
    const t = await tenant('res-big');
    const items = Array.from({ length: 24 }, (_, i) => antItem(`big-${String(i)}`, 'x'));
    const id = (await submitAnthropic(t.key, 'claude-bigresults', items)).body.id as string;
    const upstream = await upstreamOf(t, id);
    completeStubBatch(upstream);
    // ~13 MiB total: past the 10 MiB buffered-response cap, which a buffering
    // reader would have refused outright.
    const pad = 'y'.repeat(560 * 1024);
    for (const r of upstream.results!) {
      (r.response!.body['content'] as { type: string; text: string }[])[0]!.text = pad;
    }
    await markCompleted(id);
    const res = await request(server)
      .get(`/v1/batches/${id}/results`)
      .set('Authorization', `Bearer ${t.key}`)
      .buffer(true)
      .parse((r, cb) => {
        let bytes = 0;
        let lines = 0;
        r.on('data', (c: Buffer) => {
          bytes += c.length;
          for (const ch of c) if (ch === 10) lines += 1;
        });
        r.on('end', () => cb(null, { bytes, lines } as unknown as string));
      });
    expect(res.status).toBe(200);
    const seen = res.body as unknown as { bytes: number; lines: number };
    expect(seen.lines).toBe(24);
    expect(seen.bytes).toBeGreaterThan(10 * 1024 * 1024);
  });

  it('back-pressures a slow client and aborts the upstream read when the client disconnects', async () => {
    const t = await tenant('res-slow');
    const items = Array.from({ length: 40 }, (_, i) => antItem(`s-${String(i)}`, 'x'));
    const id = (await submitAnthropic(t.key, 'claude-bigresults', items)).body.id as string;
    const upstream = await upstreamOf(t, id);
    completeStubBatch(upstream);
    const pad = 'z'.repeat(256 * 1024);
    for (const r of upstream.results!) {
      (r.response!.body['content'] as { type: string; text: string }[])[0]!.text = pad;
    }
    await markCompleted(id);
    const before = h.stub.resultLinesSent();

    const req = http.request({
      host: '127.0.0.1',
      port,
      path: `/v1/batches/${id}/results`,
      headers: { authorization: `Bearer ${t.key}` },
    });
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      req.on('response', resolve);
      req.on('error', reject);
      req.end();
    });
    res.pause(); // a client that stops reading
    // The stub writes drain-aware, so the pipeline stalls well short of the set.
    await new Promise((r) => setTimeout(r, 400));
    const stalledAt = h.stub.resultLinesSent() - before;
    expect(stalledAt).toBeGreaterThan(0);
    expect(stalledAt).toBeLessThan(40);
    await new Promise((r) => setTimeout(r, 200));
    expect(h.stub.resultLinesSent() - before).toBe(stalledAt); // genuinely stalled

    // Disconnecting aborts the upstream fetch rather than draining it to nowhere.
    req.destroy();
    await new Promise((r) => setTimeout(r, 300));
    expect(h.stub.resultLinesSent() - before).toBeLessThan(40);
  });

  it('a mid-stream upstream failure ends with a terminal error object, never a silent truncation', async () => {
    const t = await tenant('res-midfail');
    const items = Array.from({ length: 6 }, (_, i) => antItem(`m-${String(i)}`, 'x'));
    const id = (await submitAnthropic(t.key, 'claude-midfail', items)).body.id as string;
    completeStubBatch(await upstreamOf(t, id));
    await markCompleted(id);
    const res = await request(server)
      .get(`/v1/batches/${id}/results`)
      .set('Authorization', `Bearer ${t.key}`)
      .buffer(true)
      .parse((r, cb) => {
        let text = '';
        r.on('data', (c: Buffer) => (text += c.toString('utf8')));
        r.on('end', () => cb(null, text));
        r.on('error', () => cb(null, text));
      });
    const lines = (res.body as string)
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const last = lines[lines.length - 1]!;
    expect(last['error']).toMatchObject({ code: 'results_stream_failed' });
    expect(last['custom_id']).toBeUndefined(); // a terminal object, not an item
    expect(JSON.stringify(last)).not.toMatch(/ECONNRESET|socket|stub/i);
  });

  it('reports an expired or never-created result set as 410, and another tenant’s id as 404', async () => {
    const t = await tenant('res-expired');
    const other = await tenant('res-other');
    const id = (await submitAnthropic(t.key, 'claude-x', [antItem('e1', 'x')])).body.id as string;
    completeStubBatch(await upstreamOf(t, id));
    await poller.sweep();
    // Past a KNOWN retention deadline: refused without an upstream call.
    await h.pool.query(
      `UPDATE batch_job SET results_expire_at = now() - interval '1 day' WHERE id = $1`,
      [id],
    );
    const expired = await request(server)
      .get(`/v1/batches/${id}/results`)
      .set('Authorization', `Bearer ${t.key}`);
    expect(expired.status).toBe(410);
    expect(expired.body.error.type).toBe('invalid_request_error');

    const foreign = await request(server)
      .get(`/v1/batches/${id}/results`)
      .set('Authorization', `Bearer ${other.key}`);
    expect(foreign.status).toBe(404);
    const missing = await request(server)
      .get('/v1/batches/nope/results')
      .set('Authorization', `Bearer ${t.key}`);
    expect(missing.status).toBe(404);
  });

  // --- 4.4 the broker guarantee (invariant 8) ------------------------------

  it('no sentinel from an item, a custom_id, or an upstream result survives anywhere but the caller’s bytes', async () => {
    const t = await tenant('res-sentinel');
    logLines.length = 0;
    const id = (
      await submitAnthropic(t.key, 'claude-x', [
        antItem(CUSTOM_ID_SENTINEL, `please summarize ${BODY_SENTINEL}`),
      ])
    ).body.id as string;
    const upstream = await upstreamOf(t, id);
    completeStubBatch(upstream);
    (upstream.results![0]!.response!.body['content'] as { type: string; text: string }[])[0]!.text =
      `the answer is ${RESULT_SENTINEL}`;
    await poller.sweep();

    // The caller's bytes DO carry them — that is the product working.
    const read = await request(server)
      .get(`/v1/batches/${id}/results`)
      .set('Authorization', `Bearer ${t.key}`)
      .buffer(true)
      .parse((r, cb) => {
        let text = '';
        r.on('data', (c: Buffer) => (text += c.toString('utf8')));
        r.on('end', () => cb(null, text));
      });
    expect(read.status).toBe(200);
    expect(read.body as string).toContain(RESULT_SENTINEL);
    expect(read.body as string).toContain(CUSTOM_ID_SENTINEL);

    // ...and nothing else does. Every column of every table, scanned as text.
    const sentinels = [BODY_SENTINEL, CUSTOM_ID_SENTINEL, RESULT_SENTINEL];
    const { rows: tables } = await h.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    for (const { table_name: table } of tables) {
      const { rows } = await h.pool.query<{ hit: string | null }>(
        `SELECT to_jsonb(t)::text AS hit FROM "${table}" t
          WHERE to_jsonb(t)::text LIKE ANY($1) LIMIT 1`,
        [sentinels.map((s) => `%${s}%`)],
      );
      expect({ table, hit: rows[0]?.hit ?? null }).toEqual({ table, hit: null });
    }
    // No log line, and no metric label or value.
    const logs = logLines.join('\n');
    const metrics = await h.metrics.metricsText();
    for (const s of sentinels) {
      expect(logs).not.toContain(s);
      expect(metrics).not.toContain(s);
    }
    // The ledger row exists and names its job — by an id derived from a digest.
    const items = (await h.port.requestLogs.list(t.principal)).filter((r) => r.batchId === id);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).not.toContain(CUSTOM_ID_SENTINEL);
  });

  it('a submission error naming an offending custom_id echoes it to its author only, never to storage', async () => {
    const t = await tenant('res-sentinel-err');
    logLines.length = 0;
    const res = await request(server)
      .post('/v1/batches')
      .set('Authorization', `Bearer ${t.key}`)
      .set('Content-Type', 'application/json')
      .send(
        JSON.stringify({
          endpoint: '/v1/messages',
          model: 'claude-x',
          requests: [
            { custom_id: CUSTOM_ID_SENTINEL, body: { max_tokens: 1, messages: [], stream: true } },
          ],
        }),
      );
    expect(res.status).toBe(400);
    // The author sees which item was wrong — that is the message's whole job.
    expect(JSON.stringify(res.body)).toContain(CUSTOM_ID_SENTINEL);
    const { rows } = await h.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM batch_job WHERE to_jsonb(batch_job)::text LIKE $1`,
      [`%${CUSTOM_ID_SENTINEL}%`],
    );
    expect(rows[0]!.n).toBe('0');
    expect(logLines.join('\n')).not.toContain(CUSTOM_ID_SENTINEL);
  });
});
