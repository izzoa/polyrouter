import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import {
  PERSISTENCE_PORT,
  REDIS_CLIENT,
  decryptSecret,
  userPrincipal,
  type PersistencePort,
} from '@polyrouter/shared/server';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { NOTIFY_RUNTIME, type NotifyRuntime } from './notify.config';
import {
  channelMatchesEvent,
  dedupId,
  deliveryId,
  renderEvent,
  windowMs,
  type NotificationEvent,
} from './notification.types';
import { parseStoredConfig, type AppriseConfig, type SmtpConfig } from './channel-config';
import { defaultRenderContext, renderNotificationChat, renderNotificationEmail } from './render';

/** Sanitized code for a render fault — never the message (it could carry a
 * field value), only the constructor name. */
function codeOf(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}
import { deliverSmtp } from './delivery/smtp.adapter';
import { deliverApprise } from './delivery/apprise.adapter';

const QUEUE_NAME = 'notify';
const SEND_TIMEOUT_MS = 15_000;
const ENQUEUE_TIMEOUT_MS = 2_000;

/** Bound a promise, rejecting if it doesn't settle in time (timer un-refed so it
 * never keeps the process alive). Used to hard-cap `enqueue` even when BullMQ's
 * `waitUntilReady` blocks on a Redis that never connects. Exported for the
 * emit-bounding e2e. */
export function withDeadline<T>(p: Promise<T>, ms: number, code: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), ms);
    timer.unref();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
const REASON_MAX = 200;

/** `message`, then every distinct `cause` message beneath it. A wrapper like
 * Drizzle's `DrizzleQueryError` carries the SQL in `message` and the ACTUAL
 * reason — `ENOTFOUND`, a dropped connection, `invalid input syntax` — only in
 * `cause`, so a handler logging `message` alone reports THAT a job failed while
 * withholding WHY (the dead end a once-a-day budget-eval failure left an
 * operator in). Each segment is flattened + clipped so one warn stays one line. */
export function jobFailureReason(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 4; depth++) {
    const raw = cur instanceof Error ? cur.message : typeof cur === 'string' ? cur : '';
    const flat = raw.replace(/\s+/g, ' ').trim();
    const text = flat.length > REASON_MAX ? `${flat.slice(0, REASON_MAX - 1)}…` : flat;
    if (text.length > 0 && !parts.includes(text)) parts.push(text);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.length > 0 ? parts.join(' ← caused by: ') : 'error';
}

const BASE_JOB_OPTS = {
  attempts: 4,
  backoff: { type: 'exponential' as const, delay: 2_000 },
  removeOnComplete: { age: 3_600 },
  removeOnFail: { age: 86_400 },
};

interface DeliverData {
  readonly channelId: string;
  readonly ownerId: string;
  readonly event: NotificationEvent;
}

/**
 * The BullMQ delivery pipeline (#15a). Two dedicated connections — a producer
 * (whose `enqueue` is deadline-bounded so it can't hang on a blackholed Redis)
 * and a BullMQ worker. `emit` → one deduplicated fan-out job → per-channel
 * delivery jobs, each retried and failure-isolated. Only sanitized codes reach
 * logs / the job store.
 */
@Injectable()
export class NotifyQueue implements OnApplicationShutdown {
  private readonly logger = new Logger('NotifyQueue');
  private readonly producerConn: Redis;
  private readonly workerConn: Redis;
  private readonly queue: Queue;
  private readonly worker: Worker;

  constructor(
    @Inject(REDIS_CLIENT) redis: Redis,
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    @Inject(NOTIFY_RUNTIME) private readonly rt: NotifyRuntime,
  ) {
    this.producerConn = redis.duplicate({
      maxRetriesPerRequest: 3,
      connectTimeout: 2_000,
      commandTimeout: 2_000,
      // Offline queue LEFT ENABLED so the brief startup-connect window (right
      // after boot, before Redis is ready) doesn't drop emits; `enqueueFanout`'s
      // withDeadline is what bounds a truly-down/blackholed Redis.
    });
    this.workerConn = redis.duplicate({ maxRetriesPerRequest: null });
    this.producerConn.on('error', () => {});
    this.workerConn.on('error', () => {});
    // Eagerly connect both (lazyConnect base) so the worker starts consuming
    // promptly instead of on its first lazy command.
    if (this.producerConn.status === 'wait') void this.producerConn.connect().catch(() => {});
    if (this.workerConn.status === 'wait') void this.workerConn.connect().catch(() => {});
    this.queue = new Queue(QUEUE_NAME, { connection: this.producerConn });
    // Queue/Worker are EventEmitters: an unhandled 'error' (e.g. a down Redis
    // raising ETIMEDOUT) would crash the process. Swallow — emit already fails
    // fast and delivery is best-effort.
    this.queue.on('error', () => {});
    this.worker = new Worker(QUEUE_NAME, (job) => this.process(job), {
      connection: this.workerConn,
      concurrency: 5,
    });
    this.worker.on('failed', (job, err) =>
      this.logger.warn(`notify delivery ${job?.id ?? '?'} failed: ${jobFailureReason(err)}`),
    );
    this.worker.on('error', () => {});
  }

  /** Resolve once the producer + worker connections are ready — for callers/tests
   * that must not race startup. Bounded so a down Redis can't hang the waiter. */
  async whenReady(timeoutMs = 10_000): Promise<void> {
    await withDeadline(
      Promise.all([this.queue.waitUntilReady(), this.worker.waitUntilReady()]).then(() => {}),
      timeoutMs,
      'notify_not_ready',
    );
  }

  /** Enqueue one deduplicated fan-out job. Hard-bounded so a blackholed Redis
   * can't stall the caller (the `emit` wrapper catches + drops on reject). */
  async enqueueFanout(event: NotificationEvent): Promise<void> {
    const w = windowMs(event.type);
    const opts =
      w > 0 ? { ...BASE_JOB_OPTS, deduplication: { id: dedupId(event), ttl: w } } : BASE_JOB_OPTS;
    await withDeadline(
      this.queue.add('fanout', { event }, opts),
      ENQUEUE_TIMEOUT_MS,
      'enqueue_timeout',
    );
  }

  private async process(job: Job): Promise<void> {
    if (job.name === 'fanout') {
      await this.fanout((job.data as { event: NotificationEvent }).event, job.timestamp);
    } else if (job.name === 'deliver') {
      await this.deliver(job.data as DeliverData);
    }
  }

  private async fanout(event: NotificationEvent, jobTimestamp: number): Promise<void> {
    const principal = userPrincipal(event.scope.ownerUserId);
    // Enabled + subscribed, intersected with the event's per-budget allow-list
    // (#16) when present.
    const channels = (await this.db.notificationChannels.list(principal)).filter((c) =>
      channelMatchesEvent(c, event),
    );
    // Bucket derives from the fan-out job's immutable timestamp, not retry time.
    const bucket = Math.floor(jobTimestamp / Math.max(windowMs(event.type), 60_000));
    for (const ch of channels) {
      await this.queue.add(
        'deliver',
        { channelId: ch.id, ownerId: event.scope.ownerUserId, event },
        { ...BASE_JOB_OPTS, jobId: deliveryId(event, ch.id, bucket) },
      );
    }
  }

  private async deliver(data: DeliverData): Promise<void> {
    const principal = userPrincipal(data.ownerId);
    const ch = await this.db.notificationChannels.findById(principal, data.channelId);
    if (ch === null || !ch.enabled) return; // deleted/disabled → skip silently
    const config = parseStoredConfig(
      ch.kind,
      decryptSecret(ch.encryptedConfig, this.rt.notifySecret),
    );
    // Presentation runs on the DELIVERY path, where a throw is retried and can
    // end as a failed delivery. Branding must never convert a working
    // notification into a lost one (invariant 11), so every render is guarded
    // and degrades to the pre-change plain-text form.
    const ctx = defaultRenderContext(this.rt.appOrigin);
    const legacy = renderEvent(data.event);
    if (ch.kind === 'smtp') {
      let mail: { title: string; body: string; html?: string } = legacy;
      try {
        const r = renderNotificationEmail(data.event, ctx);
        mail = { title: r.subject, body: r.text, html: r.html };
      } catch (err) {
        this.logger.warn(`branded email render failed; sending plain text: ${codeOf(err)}`);
      }
      await deliverSmtp(config as SmtpConfig, mail, this.rt, SEND_TIMEOUT_MS);
    } else {
      let chat: { title: string; body: string; type?: string; format?: string } = legacy;
      try {
        chat = renderNotificationChat(data.event, ctx);
      } catch (err) {
        this.logger.warn(`chat render failed; sending plain text: ${codeOf(err)}`);
      }
      await deliverApprise(config as AppriseConfig, chat, this.rt, SEND_TIMEOUT_MS);
    }
    // A throw → BullMQ retries; final failure is logged in the 'failed' handler.
  }

  async onApplicationShutdown(): Promise<void> {
    // Bound the graceful close: a worker blocked on an unreachable Redis (its
    // blocking read never returns) must not hang shutdown — fall through to a
    // forced disconnect (invariant 12).
    const bounded = (p: Promise<unknown>): Promise<void> =>
      Promise.race([
        p.then(
          () => {},
          () => {},
        ),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 2_000);
          t.unref();
        }),
      ]);
    await bounded(this.worker.close());
    await bounded(this.queue.close());
    this.producerConn.disconnect();
    this.workerConn.disconnect();
  }
}
