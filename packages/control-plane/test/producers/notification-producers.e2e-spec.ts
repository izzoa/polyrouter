import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadConfig } from '@polyrouter/shared';
import { REDIS_CLIENT } from '@polyrouter/shared/server';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { DatabaseModule } from '../../src/database/database.module';
import { RedisModule } from '../../src/redis/redis.module';
import '../../src/database/database.config';
import '../../src/redis/redis.config';
import {
  WEEKLY_SPEND_READER,
  type WeeklySpendReader,
} from '../../src/database/weekly-spend.reader';
import { BUDGET_READER, type BudgetReader } from '../../src/database/budget.reader';
import { NotificationProducers } from '../../src/producers/notification-producers';
import { SystemMailer } from '../../src/producers/system-mailer';
import { WeeklySummaryScheduler } from '../../src/producers/weekly-summary.scheduler';
import type { ProducersConfig } from '../../src/producers/producers.config';
import type { NotificationService } from '../../src/notifications/notification.service';
import type { NotificationEvent } from '../../src/notifications/notification.types';
import { startSmtpStub, waitFor, type SmtpStub } from '../notifications/stubs';

const HINT = 'Dev Postgres/Redis unreachable — docker compose -f docker-compose.dev.yml up -d';

function baseCfg(over: Partial<ProducersConfig> = {}): ProducersConfig {
  return {
    mode: 'selfhosted',
    allowedEndpoints: [],
    systemSmtp: undefined,
    failureThreshold: 3,
    failureWindowMs: 900_000,
    weeklyEnabled: false,
    weeklyCron: '0 8 * * 1',
    ...over,
  };
}

/** A capturing NotificationService (no queue) so we test the producer logic +
 * real infra, not #15a's already-tested delivery. */
function captureNotifications(): { svc: NotificationService; events: NotificationEvent[] } {
  const events: NotificationEvent[] = [];
  const svc = {
    emit: (e: NotificationEvent) => {
      events.push(e);
      return Promise.resolve();
    },
  } as unknown as NotificationService;
  return { svc, events };
}

describe('notification producers — real infra (#15b)', () => {
  let app: INestApplication;
  let pool: Pool;
  let redis: Redis;
  let reader: WeeklySpendReader;
  let budgetReader: BudgetReader;
  let smtp: SmtpStub;
  const userIds: string[] = [];

  async function makeUser(label: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      'INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, false)',
      [id, label, `${label}-${id}@producers.test`],
    );
    userIds.push(id);
    return id;
  }

  async function seedLog(owner: string, cost: number | null, createdAt: Date): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO request_log
        (id, owner_user_id, decision_layer, routing_reason, input_tokens, output_tokens, duration_ms, status, cost, created_at)
       VALUES ($1,$2,'default','test',0,0,1,'success',$3,$4)`,
      [id, owner, cost, createdAt],
    );
    return id;
  }
  async function seedAttempt(logId: string, owner: string, cost: number | null, createdAt: Date) {
    await pool.query(
      `INSERT INTO request_attempt
        (id, request_log_id, owner_user_id, attempt_index, input_tokens, output_tokens, status, cost, created_at)
       VALUES ($1,$2,$3,0,0,0,'success',$4,$5)`,
      [randomUUID(), logId, owner, cost, createdAt],
    );
  }

  beforeAll(async () => {
    const databaseUrl = loadConfig<{ DATABASE_URL: string }>().DATABASE_URL;
    pool = new Pool({ connectionString: databaseUrl, max: 3 });
    try {
      await pool.query('SELECT 1');
    } catch (e) {
      await pool.end();
      throw new Error(`${HINT}\n(${(e as Error).message})`);
    }
    const moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, RedisModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.enableShutdownHooks();
    await app.init();
    reader = app.get<WeeklySpendReader>(WEEKLY_SPEND_READER);
    budgetReader = app.get<BudgetReader>(BUDGET_READER);
    redis = app.get<Redis>(REDIS_CLIENT);
    smtp = await startSmtpStub();
  }, 60_000);

  afterAll(async () => {
    if (userIds.length > 0) await pool.query('DELETE FROM "user" WHERE id = ANY($1)', [userIds]);
    await app?.close();
    await pool?.end();
    await smtp?.close();
  });

  it('weeklySpendByOwner sums both ledgers over [start,end), per owner, excluding out-of-window', async () => {
    const a = await makeUser('wk-a');
    const b = await makeUser('wk-b');
    const now = Date.now();
    const inWindow = new Date(now - 86_400_000); // 1 day ago
    const outOfWindow = new Date(now - 30 * 86_400_000); // 30 days ago
    // A: log 10 (in) + attempt 5 (in) + null-cost log (in, → 0) + log 100 (OUT) = 15
    const logA = await seedLog(a, 10, inWindow);
    await seedAttempt(logA, a, 5, inWindow);
    await seedLog(a, null, inWindow);
    await seedLog(a, 100, outOfWindow);
    // B: log 3 (in) = 3
    await seedLog(b, 3, inWindow);

    const start = new Date(now - 7 * 86_400_000);
    const end = new Date(now + 1000);
    const rows = await reader.weeklySpendByOwner(start, end);
    const map = new Map(rows.map((r) => [r.ownerUserId, r.total]));
    expect(map.get(a)).toBeCloseTo(15, 6);
    expect(map.get(b)).toBeCloseTo(3, 6);
  });

  it('the weekly total reconciles EXACTLY with the budget reader in micro-dollars (A-15)', async () => {
    const owner = await makeUser('wk-micro');
    const now = Date.now();
    const at = new Date(now - 86_400_000);
    const start = new Date(now - 7 * 86_400_000);
    const end = new Date(now + 1000);
    // Sub-µ$ costs chosen so a raw float `sum(cost)` diverges from the per-row µ$ sum
    // every other reader uses: three rows of 0.0000004 (→ round to 0 µ$ each) + one of
    // 0.00000075 (→ 1 µ$). Float sum = 0.00000195; per-row µ$ sum = 1 µ$ = 0.000001.
    const logId = await seedLog(owner, 0.0000004, at);
    await seedAttempt(logId, owner, 0.0000004, at);
    await seedLog(owner, 0.0000004, at);
    await seedLog(owner, 0.00000075, at);

    const weekly = await reader.weeklySpendByOwner(start, end);
    const weeklyTotal = new Map(weekly.map((r) => [r.ownerUserId, r.total])).get(owner);
    const budgetMicros = (await budgetReader.spendMicrosFor(owner, null, start, end)).micros;

    // The weekly reader now aggregates in µ$ exactly like the budget reader — so their
    // figures are identical, not merely close. A float `sum(cost)` would give 0.00000195.
    expect(budgetMicros).toBe(1); // round(0.4)+round(0.4)+round(0.4)+round(0.75) = 1
    expect(weeklyTotal).toBe(budgetMicros / 1_000_000);
    expect(weeklyTotal).not.toBeCloseTo(0.00000195, 10); // the old float-sum value
  });

  it('the spike counter (real Redis Lua) alerts once at the threshold, owner-scoped', async () => {
    const a = await makeUser('spike-a');
    const b = await makeUser('spike-b');
    const { svc, events } = captureNotifications();
    const producers = new NotificationProducers(svc, redis, baseCfg({ failureThreshold: 3 }));
    const pa = { kind: 'user' as const, userId: a };
    const pb = { kind: 'user' as const, userId: b };

    await producers.onRequestFailed(pa); // 1
    await producers.onRequestFailed(pa); // 2
    expect(events).toHaveLength(0);
    await producers.onRequestFailed(pa); // 3 → alert
    await producers.onRequestFailed(pa); // 4 → no re-alert
    const spikes = events.filter((e) => e.type === 'request_failures_spike');
    expect(spikes).toHaveLength(1);
    expect(spikes[0]!.scope.ownerUserId).toBe(a);
    expect(spikes[0]!.fields['count']).toBe(3);

    // owner B's failures are counted separately (no cross-owner leakage)
    await producers.onRequestFailed(pb);
    expect(events.filter((e) => e.scope.ownerUserId === b)).toHaveLength(0);
  });

  it('SystemMailer sends via the SSRF-guarded SMTP path to a loopback relay (self-host)', async () => {
    const mailer = new SystemMailer(
      baseCfg({
        systemSmtp: {
          host: '127.0.0.1',
          port: smtp.port,
          secure: 'none',
          from: 'sys@polyrouter.test',
        },
      }),
    );
    expect(mailer.configured).toBe(true);
    const before = smtp.messages.length;
    await mailer.send('user@x.z', 'Reset your polyrouter password', 'Reset link: https://x/z');
    expect(await waitFor(() => smtp.messages.length === before + 1)).toBe(true);
  });

  it('the weekly scheduler bootstrap is non-blocking + reconciles cleanly (fail-open by construction)', async () => {
    const { svc } = captureNotifications();
    const scheduler = new WeeklySummaryScheduler(
      redis,
      reader,
      svc,
      baseCfg({ weeklyEnabled: true }),
    );
    // onApplicationBootstrap is fire-and-forget: it returns synchronously and
    // never throws — so a down Redis at boot can't gate Layer 0 (invariant 1).
    expect(scheduler.onApplicationBootstrap()).toBeUndefined();
    // let the background reconcile register the schedule, then shut down cleanly.
    await new Promise((r) => setTimeout(r, 800));
    await scheduler.onApplicationShutdown();
    // clean up the registered scheduler so it doesn't linger on the shared queue.
    const conn = new Redis(loadConfig<{ REDIS_URL: string }>().REDIS_URL, {
      maxRetriesPerRequest: null,
    });
    const q = new (await import('bullmq')).Queue('producers', { connection: conn });
    await q.removeJobScheduler('weekly-summary').catch(() => undefined);
    await q.close();
    conn.disconnect();
  }, 20_000);
});
